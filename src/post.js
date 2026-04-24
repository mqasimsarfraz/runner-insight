const core = require("@actions/core");
const { execSync } = require("child_process");
const fs = require("fs");
const {
  REMOTE_ADDRESS,
  loadState,
  sudo,
} = require("./common");

async function post() {
  const state = loadState();
  if (!state) {
    core.info("No runner-insight state found, skipping cleanup.");
    return;
  }

  const failOnError = core.getInput("fail-on-error") === "true";
  let hasFailure = false;
  const sections = [];

  try {
    // 1. Stop trace gadgets via gadgetctl delete
    if (state.traceGadgets && state.traceGadgets.length > 0) {
      for (const g of state.traceGadgets) {
        core.startGroup(`Stopping trace: ${g.instanceName}`);
        const deleteArgs = ["delete", g.instanceId || g.instanceName, "--remote-address", REMOTE_ADDRESS];
        const result = sudo("gadgetctl", deleteArgs, { ignoreError: true });
        if (result.exitCode !== 0) {
          core.warning(`Failed to delete ${g.instanceName}: ${result.stderr}`);
        } else {
          core.info(`Stopped ${g.instanceName}`);
        }
        core.endGroup();
      }
    }

    // Give the logs operator a moment to flush
    execSync("sleep 1");

    // 2. Parse log file and build sections for trace gadgets
    if (state.traceGadgets && state.traceGadgets.length > 0) {
      const traceData = parseLogFile(state.logFile, state.traceGadgets);
      for (const g of state.traceGadgets) {
        const events = traceData[g.instanceName] || [];
        const display = g.args.length > 0 ? `${g.name} ${g.args.join(" ")}` : g.name;
        sections.push({
          gadget: g.name,
          display,
          status: events.length > 0 ? "success" : "warning",
          rows: events.length,
          output: formatTraceEvents(events, g.args),
        });
      }
    }

    // 3. Run snapshot gadgets with timeout
    if (state.snapshotGadgets && state.snapshotGadgets.length > 0) {
      for (const g of state.snapshotGadgets) {
        core.startGroup(`Running snapshot: ${g.name}`);
        const result = runSnapshotGadget(g, state.useHost);
        sections.push(result);
        if (result.status === "error") hasFailure = true;
        core.endGroup();
      }
    }

    // 4. Kill daemon
    killDaemon(state);

    // 5. Generate Job Summary
    generateSummary(sections);

    if (failOnError && hasFailure) {
      core.setFailed(
        "One or more gadgets failed. Set fail-on-error: false to report without failing."
      );
    }
  } catch (error) {
    core.warning(`runner-insight cleanup error: ${error.message}`);
    killDaemon(state);
  }
}

function runSnapshotGadget(g, useHost) {
  const args = ["run", g.name, "-t", "5"];
  if (useHost) args.push("--host");
  args.push(...g.args);

  const start = Date.now();
  const result = sudo("ig", args, { ignoreError: true });
  const duration = Date.now() - start;
  const display = g.args.length > 0 ? `${g.name} ${g.args.join(" ")}` : g.name;

  const lines = result.stdout ? result.stdout.split("\n").filter(Boolean) : [];

  if (result.exitCode !== 0) {
    core.warning(
      `Snapshot ${g.name} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
    );
    return {
      gadget: g.name,
      display,
      status: "error",
      duration,
      rows: 0,
      output: result.stderr || result.stdout || "_No output._",
    };
  }

  return {
    gadget: g.name,
    display,
    status: "success",
    duration,
    rows: lines.length > 1 ? lines.length - 1 : 0,
    output: result.stdout || "_No output captured._",
  };
}

function parseLogFile(logFilePath, traceGadgets) {
  const data = {};
  for (const g of traceGadgets) {
    data[g.instanceName] = [];
  }

  if (!logFilePath || !fs.existsSync(logFilePath)) {
    core.warning(`Log file not found: ${logFilePath}`);
    return data;
  }

  let content;
  try {
    content = fs.readFileSync(logFilePath, "utf8");
  } catch {
    // Fall back to sudo if permission denied
    const result = sudo("cat", [logFilePath], { ignoreError: true });
    if (result.exitCode !== 0) {
      core.warning(`Cannot read log file: ${result.stderr}`);
      return data;
    }
    content = result.stdout;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "gadget-data") continue;

      const logId = entry.instanceID || "";

      // Match by instanceID (we generate full 32-char IDs via --id)
      const g = traceGadgets.find(
        (g) => g.instanceId && logId === g.instanceId
      );
      if (!g) continue;

      if (entry.data) {
        if (Array.isArray(entry.data)) {
          data[g.instanceName].push(...entry.data);
        } else {
          data[g.instanceName].push(entry.data);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return data;
}

function formatTraceEvents(events, userArgs) {
  if (events.length === 0) return "_No events captured._";

  // Determine which fields to show
  const requestedFields = getRequestedFields(userArgs);

  // Use requested fields if specified, otherwise pick sensible defaults from the first event
  let keys;
  if (requestedFields.length > 0) {
    keys = requestedFields;
  } else {
    keys = selectDisplayFields(events[0]);
  }

  const header = keys.join("\t");
  const MAX_ROWS = 100;
  const rows = events.slice(0, MAX_ROWS).map((e) => {
    return keys.map((k) => resolveField(e, k)).join("\t");
  });

  let table = [header, ...rows].join("\n");
  if (events.length > MAX_ROWS) {
    table += `\n\n... ${events.length - MAX_ROWS} more events not shown`;
  }
  return table;
}

// Extract --fields value from user args
function getRequestedFields(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fields" && i + 1 < args.length) {
      return args[i + 1].split(",").map((f) => f.trim());
    }
    if (args[i].startsWith("--fields=")) {
      return args[i].slice("--fields=".length).split(",").map((f) => f.trim());
    }
  }
  return [];
}

// Pick important top-level fields, skip runtime/k8s metadata
function selectDisplayFields(event) {
  const skip = new Set(["k8s", "runtime", "timestamp_raw", "mntns_id", "netns_id"]);
  const fields = [];
  for (const key of Object.keys(event)) {
    if (skip.has(key)) continue;
    const val = event[key];
    if (typeof val === "object" && val !== null) continue;
    fields.push(key);
    if (fields.length >= 10) break;
  }
  return fields;
}

// Resolve potentially nested field paths like "src.addr"
function resolveField(obj, fieldPath) {
  const parts = fieldPath.split(".");
  let val = obj;
  for (const p of parts) {
    if (val == null || typeof val !== "object") return "";
    val = val[p];
  }
  if (val == null) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function killDaemon(state) {
  if (state && state.daemonPid) {
    core.info(`Killing ig daemon (PID: ${state.daemonPid})`);
    try {
      execSync(`sudo kill -9 ${state.daemonPid} 2>/dev/null || true`);
    } catch {
      // ignore
    }
  }
}

function generateSummary(sections) {
  const lines = ["## 🔍 Runner Insight Report", ""];

  for (const s of sections) {
    const icon =
      s.status === "success"
        ? "✅"
        : s.status === "warning"
          ? "⚠️"
          : "❌";
    const durationStr = s.duration ? ` · ${formatDuration(s.duration)}` : "";
    const rowStr = s.rows !== undefined ? ` · ${s.rows} events` : "";

    lines.push(`<details open>`);
    lines.push(
      `<summary><strong>${icon} ${s.display}</strong>${durationStr}${rowStr}</summary>`
    );
    lines.push("");

    if (
      s.output &&
      s.output !== "_No output captured._" &&
      s.output !== "_No events captured._"
    ) {
      lines.push("```");
      lines.push(s.output);
      lines.push("```");
    } else {
      lines.push(s.output || "_No output captured._");
    }

    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  const summary = lines.join("\n");
  core.summary.addRaw(summary);
  core.summary.write();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

post();
