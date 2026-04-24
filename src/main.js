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
    execSync(
      `sudo setsid ig daemon --config ${configPath} >> ${daemonLogPath} 2>&1 &`,
      { stdio: "inherit" }
    );

    // Wait for socket to appear
    await waitForSocket(SOCKET_PATH, 15);

    // Verify daemon is responsive
    const listResult = sudo("gadgetctl", ["list", "--remote-address", REMOTE_ADDRESS], {
      ignoreError: true,
    });
    if (listResult.exitCode !== 0) {
      core.setFailed(`ig daemon not responsive: ${listResult.stderr}`);
      return;
    }
    core.info("ig daemon is running and responsive");
    core.endGroup();

    const state = {
      outputDir: dir,
      useHost,
      logFile: logPath,
      configFile: configPath,
      daemonLogPath,
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

      // Parse instance ID from output: 'installed as "ID"'
      const match = (result.stdout + "\n" + result.stderr).match(
        /installed as "([a-f0-9]+)"/
      );
      const instanceId = match ? match[1] : "";

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

function waitForSocket(socketPath, timeoutSec) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (fs.existsSync(socketPath)) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutSec * 1000) {
        clearInterval(interval);
        reject(new Error(`ig daemon socket not found after ${timeoutSec}s`));
      }
    }, 500);
  });
}

main();
