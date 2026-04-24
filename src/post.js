const core = require("@actions/core");
const { execSync } = require("child_process");
const fs = require("fs");
const {
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
    // 1. Stop trace gadgets and collect output
    if (state.traceGadgets && state.traceGadgets.length > 0) {
      for (const g of state.traceGadgets) {
        core.startGroup(`Stopping trace: ${g.name} (PID: ${g.pid})`);

        // Send SIGINT for graceful shutdown, then SIGKILL as fallback
        try {
          execSync(`sudo kill -INT ${g.pid} 2>/dev/null || true`);
          execSync("sleep 1");
          execSync(`sudo kill -9 ${g.pid} 2>/dev/null || true`);
        } catch {
          // ignore
        }

        const display =
          g.args.length > 0 ? `${g.name} ${g.args.join(" ")}` : g.name;
        let output = "";
        let stderr = "";

        try {
          output = fs.readFileSync(g.outFile, "utf8").trim();
        } catch {
          output = "";
        }
        try {
          stderr = fs.readFileSync(g.errFile, "utf8").trim();
        } catch {
          stderr = "";
        }

        const lines = output ? output.split("\n").filter(Boolean) : [];
        const rows = lines.length > 1 ? lines.length - 1 : 0;

        sections.push({
          gadget: g.name,
          display,
          status: output ? "success" : "warning",
          rows,
          output: output || "_No events captured._",
          stderr,
        });

        core.info(`Collected ${rows} rows from ${g.name}`);
        core.endGroup();
      }
    }

    // 2. Run snapshot gadgets with timeout
    if (state.snapshotGadgets && state.snapshotGadgets.length > 0) {
      for (const g of state.snapshotGadgets) {
        core.startGroup(`Running snapshot: ${g.name}`);
        const result = runSnapshotGadget(g, state.useHost);
        sections.push(result);
        if (result.status === "error") hasFailure = true;
        core.endGroup();
      }
    }

    // 3. Generate Job Summary
    generateSummary(sections);

    if (failOnError && hasFailure) {
      core.setFailed(
        "One or more gadgets failed. Set fail-on-error: false to report without failing."
      );
    }
  } catch (error) {
    core.warning(`runner-insight cleanup error: ${error.message}`);
  }
}

function runSnapshotGadget(g, useHost) {
  const args = ["run", g.name, "-t", "30"];
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
    const rowStr = s.rows !== undefined ? ` · ${s.rows} rows` : "";

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

    if (s.stderr) {
      lines.push("");
      lines.push("> ⚠️ **Warnings:**");
      for (const errline of s.stderr.split("\n").slice(0, 10)) {
        lines.push(`> \`${errline}\``);
      }
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
