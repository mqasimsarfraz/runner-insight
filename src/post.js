const core = require("@actions/core");
const { execSync } = require("child_process");
const fs = require("fs");
const {
  SOCKET_PATH,
  loadState,
  sudo,
  isTrace,
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
    // 1. Run snapshot gadgets
    if (state.snapshotGadgets && state.snapshotGadgets.length > 0) {
      for (const g of state.snapshotGadgets) {
        core.startGroup(`Running snapshot: ${g.name}`);
        const result = runSnapshotGadget(g, state.useHost);
        sections.push(result);
        if (result.status === "error") hasFailure = true;
        core.endGroup();
      }
    }

    // 2. Stop trace gadgets and collect from log file
    if (state.traceGadgets && state.traceGadgets.length > 0) {
      // Delete detached instances (stops collection)
      for (const g of state.traceGadgets) {
        core.startGroup(`Stopping trace: ${g.instanceName}`);
        const result = sudo(
          "gadgetctl",
          [
            "delete",
            g.instanceName,
            "--remote-address",
            `unix://${SOCKET_PATH}`,
          ],
          { ignoreError: true }
        );
        if (result.exitCode !== 0) {
          core.warning(`Failed to delete ${g.instanceName}: ${result.stderr}`);
        } else {
          core.info(`Stopped ${g.instanceName}`);
        }
        core.endGroup();
      }

      // Parse log file and build sections per trace gadget
      const traceData = parseLogFile(state.logFile, state.traceGadgets);
      for (const g of state.traceGadgets) {
        const events = traceData[g.instanceName] || [];
        const display = g.args.length > 0 ? `${g.name} ${g.args.join(" ")}` : g.name;
        sections.push({
          gadget: g.name,
          display,
          status: "success",
          rows: events.length,
          output: formatTraceEvents(events),
        });
      }
    }

    // 3. Kill daemon
    killDaemon(state);

    // 4. Generate Job Summary
    generateSummary(sections);

    if (failOnError && hasFailure) {
      core.setFailed(
        "One or more gadgets failed. Set fail-on-error: false to report without failing."
      );
    }
  } catch (error) {
    core.warning(`runner-insight cleanup error: ${error.message}`);
    // Still try to kill daemon
    killDaemon(state);
  }
}

function runSnapshotGadget(g, useHost) {
  const args = ["ig", "run", g.name];
  if (useHost) args.push("--host");
  args.push(...g.args);

  const start = Date.now();
  const result = sudo(args[0], args.slice(1), { ignoreError: true });
  const duration = Date.now() - start;
  const display = g.args.length > 0 ? `${g.name} ${g.args.join(" ")}` : g.name;

  const lines = result.stdout ? result.stdout.split("\n").filter(Boolean) : [];

  if (result.exitCode !== 0) {
    core.warning(`Snapshot ${g.name} failed: ${result.stderr}`);
    return {
      gadget: g.name,
      display,
      status: "error",
      duration,
      rows: 0,
      output: result.stderr || result.stdout || "No output",
    };
  }

  return {
    gadget: g.name,
    display,
    status: "success",
    duration,
    rows: lines.length > 1 ? lines.length - 1 : 0, // exclude header
    output: result.stdout || "_No output captured._",
  };
}

function parseLogFile(logFilePath, traceGadgets) {
  const data = {};
  for (const g of traceGadgets) {
    data[g.instanceName] = [];
  }

  if (!fs.existsSync(logFilePath)) {
    core.warning(`Log file not found: ${logFilePath}`);
    return data;
  }

  const instanceMap = {};
  for (const g of traceGadgets) {
    instanceMap[g.instanceName] = g;
  }

  const content = fs.readFileSync(logFilePath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "gadget-data") continue;

      // Match by instanceID or instanceName
      const name = entry.instanceName || "";
      const id = entry.instanceID || "";

      // Find matching gadget
      for (const g of traceGadgets) {
        if (name === g.instanceName || (g.instanceId && id === g.instanceId)) {
          if (entry.data) {
            if (Array.isArray(entry.data)) {
              data[g.instanceName].push(...entry.data);
            } else {
              data[g.instanceName].push(entry.data);
            }
          }
          break;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return data;
}

function formatTraceEvents(events) {
  if (events.length === 0) return "_No events captured._";

  // Build a columns-style table from JSON objects
  const keys = Object.keys(events[0]);
  const header = "| " + keys.join(" | ") + " |";
  const separator = "| " + keys.map(() => "---").join(" | ") + " |";

  const MAX_ROWS = 50;
  const rows = events.slice(0, MAX_ROWS).map((e) => {
    return "| " + keys.map((k) => String(e[k] ?? "")).join(" | ") + " |";
  });

  let table = [header, separator, ...rows].join("\n");
  if (events.length > MAX_ROWS) {
    table += `\n\n_Showing ${MAX_ROWS} of ${events.length} events._`;
  }
  return table;
}

function killDaemon(state) {
  if (state.daemonPid) {
    core.info(`Killing ig daemon (PID: ${state.daemonPid})`);
    try {
      execSync(`sudo kill ${state.daemonPid} 2>/dev/null || true`);
    } catch {
      // ignore
    }
  }
  // Also try pkill as fallback via PID file
  try {
    execSync("sudo pkill -f 'ig daemon' 2>/dev/null || true");
  } catch {
    // ignore
  }
}

function generateSummary(sections) {
  const lines = ["## 🔍 Runner Insight Report", ""];

  for (const s of sections) {
    const icon =
      s.status === "success" ? "✅" : s.status === "timeout" ? "⏱️" : "❌";
    const durationStr = s.duration ? ` · ${formatDuration(s.duration)}` : "";
    const rowStr = s.rows !== undefined ? ` · ${s.rows} rows` : "";

    lines.push(`<details open>`);
    lines.push(
      `<summary><strong>${icon} ${s.display}</strong>${durationStr}${rowStr}</summary>`
    );
    lines.push("");

    if (s.output && s.output.startsWith("|")) {
      // Markdown table — render directly
      lines.push(s.output);
    } else if (s.output && s.output !== "_No output captured._" && s.output !== "_No events captured._") {
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
