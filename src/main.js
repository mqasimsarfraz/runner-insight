const core = require("@actions/core");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const {
  SOCKET_PATH,
  REMOTE_ADDRESS,
  outputDir,
  logFile,
  configFile,
  saveState,
  parseGadgetLine,
  sudo,
  isTrace,
} = require("./common");

async function main() {
  try {
    if (os.platform() !== "linux") {
      core.setFailed("runner-insight only supports Linux runners.");
      return;
    }

    // Verify ig and gadgetctl are installed (setup-ig should have done this)
    verifyTools();

    const gadgetsInput = core.getInput("gadgets", { required: true });
    const useHost = core.getInput("host") !== "false";

    const gadgetLines = gadgetsInput
      .split("\n")
      .map((l) => parseGadgetLine(l))
      .filter(Boolean);

    if (gadgetLines.length === 0) {
      core.setFailed("No valid gadgets specified.");
      return;
    }

    const traceGadgets = gadgetLines.filter((g) => isTrace(g.name));
    const snapshotGadgets = gadgetLines.filter((g) => !isTrace(g.name));

    const dir = outputDir();
    const logPath = logFile();
    const configPath = configFile();

    // Write ig daemon config with logs operator
    core.startGroup("Configuring ig daemon");
    const config = [
      "operator:",
      "  logs:",
      "    enabled: true",
      "    channel: file",
      `    filename: ${logPath}`,
      "    format: json",
      "    mode: detached",
    ].join("\n");
    fs.writeFileSync(configPath, config);
    core.info(`Config written to ${configPath}`);
    core.endGroup();

    // Start ig daemon
    core.startGroup("Starting ig daemon");
    const daemonLogPath = `${dir}/daemon.log`;

    // Ensure socket dir and log file exist with correct permissions
    execSync("sudo mkdir -p /var/run/ig", { stdio: "inherit" });
    fs.writeFileSync(daemonLogPath, "");
    // Pre-create gadget log file so daemon (root) appends to it and runner user can read
    fs.writeFileSync(logPath, "");
    execSync(`chmod 666 ${logPath}`, { stdio: "inherit" });

    const daemonPidFile = `${dir}/daemon.pid`;
    execSync(
      `sudo bash -c 'nohup ig daemon --config ${configPath} >>${daemonLogPath} 2>&1 & echo $! > ${daemonPidFile}'`,
      { stdio: "inherit" }
    );

    // Wait for socket with readiness polling
    await waitForDaemon(SOCKET_PATH, REMOTE_ADDRESS, 30);

    let daemonPid = "";
    try { daemonPid = fs.readFileSync(daemonPidFile, "utf8").trim(); } catch { /* ignore */ }
    core.info(`ig daemon is running (PID: ${daemonPid})`);
    core.endGroup();

    const state = {
      outputDir: dir,
      useHost,
      logFile: logPath,
      configFile: configPath,
      daemonLogPath,
      daemonPid,
      snapshotGadgets,
      traceGadgets: [],
    };

    // Start trace gadgets as detached instances via gadgetctl
    for (let i = 0; i < traceGadgets.length; i++) {
      const g = traceGadgets[i];
      const instanceName = `ri-${i}-${g.name}`;

      core.startGroup(`Starting trace gadget: ${g.name}`);

      const args = [
        "run", g.name,
        "--detach",
        "--name", instanceName,
        "--remote-address", REMOTE_ADDRESS,
      ];
      if (useHost) args.push("--host");
      args.push(...g.args);

      const result = sudo("gadgetctl", args, { ignoreError: true });

      if (result.exitCode !== 0) {
        core.warning(`Failed to start ${g.name}: ${result.stderr || result.stdout}`);
        core.endGroup();
        continue;
      }

      // Look up instance ID via gadgetctl list
      const instanceId = getInstanceId(instanceName);

      core.info(`Started ${g.name} as ${instanceName} (ID: ${instanceId})`);
      state.traceGadgets.push({
        ...g,
        index: i,
        instanceName,
        instanceId,
      });

      core.endGroup();
    }

    saveState(state);
    core.info(
      `Runner Insight: ${state.traceGadgets.length} trace gadget(s) running, ${snapshotGadgets.length} snapshot(s) queued for cleanup.`
    );
  } catch (error) {
    core.setFailed(`runner-insight failed: ${error.message}`);
  }
}

// Look up instance ID by name via gadgetctl list
function getInstanceId(instanceName) {
  const result = sudo("gadgetctl", ["list", "--remote-address", REMOTE_ADDRESS], {
    ignoreError: true,
  });
  if (result.exitCode !== 0) return "";
  for (const line of result.stdout.split("\n")) {
    const cols = line.trim().split(/\s{2,}/);
    // columns: ID, NAME, TAGS, GADGET, STATUS
    if (cols.length >= 2 && cols[1] === instanceName) {
      return cols[0].trim();
    }
  }
  return "";
}

function verifyTools() {
  try {
    execSync("which ig", { stdio: "pipe" });
  } catch {
    core.setFailed(
      "ig not found. Add mqasimsarfraz/setup-ig before this action."
    );
    throw new Error("ig not found");
  }
  try {
    execSync("which gadgetctl", { stdio: "pipe" });
  } catch {
    core.setFailed(
      "gadgetctl not found. Add mqasimsarfraz/setup-ig before this action."
    );
    throw new Error("gadgetctl not found");
  }
}

function waitForDaemon(socketPath, remoteAddress, timeoutSec) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const daemonLogPath = `${outputDir()}/daemon.log`;
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;

      if (!fs.existsSync(socketPath)) {
        if (elapsed > timeoutSec) {
          clearInterval(interval);
          // Show daemon log for debugging
          try {
            const log = fs.readFileSync(daemonLogPath, "utf8").trim();
            if (log) core.info(`Daemon log:\n${log}`);
          } catch { /* ignore */ }
          reject(new Error(`ig daemon socket not found after ${timeoutSec}s`));
        }
        return;
      }

      // Socket exists — try gadgetctl list as readiness check
      const result = sudo("gadgetctl", ["list", "--remote-address", remoteAddress], {
        ignoreError: true,
      });
      if (result.exitCode === 0) {
        clearInterval(interval);
        resolve();
      } else if (elapsed > timeoutSec) {
        clearInterval(interval);
        try {
          const log = fs.readFileSync(daemonLogPath, "utf8").trim();
          if (log) core.info(`Daemon log:\n${log}`);
        } catch { /* ignore */ }
        reject(new Error(`ig daemon not responsive after ${timeoutSec}s: ${result.stderr}`));
      }
    }, 1000);
  });
}

main();
