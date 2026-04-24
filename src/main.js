const core = require("@actions/core");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const {
  SOCKET_PATH,
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
    // Platform check
    if (os.platform() !== "linux") {
      core.setFailed("runner-insight only supports Linux runners.");
      return;
    }

    const igVersion = core.getInput("ig-version") || "latest";
    const gadgetsInput = core.getInput("gadgets", { required: true });
    const useHost = core.getInput("host") !== "false";

    // Parse gadget lines
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

    // Install ig
    core.startGroup("Installing ig");
    installIg(igVersion);
    core.endGroup();

    const state = {
      outputDir: outputDir(),
      logFile: logFile(),
      useHost,
      snapshotGadgets,
      traceGadgets: [],
      daemonPid: null,
    };

    // If we have trace gadgets, start the daemon
    if (traceGadgets.length > 0) {
      core.startGroup("Starting ig daemon");
      state.daemonPid = startDaemon(state);
      core.endGroup();

      // Start trace gadgets in detached mode
      for (let i = 0; i < traceGadgets.length; i++) {
        const g = traceGadgets[i];
        const instanceName = `ri-${i}-${g.name}`;
        core.startGroup(`Starting trace gadget: ${g.name}`);

        const args = [
          "run",
          g.name,
          "--detach",
          "--name",
          instanceName,
          "--remote-address",
          `unix://${SOCKET_PATH}`,
        ];
        if (useHost) args.push("--host");
        args.push(...g.args);

        const result = sudo("gadgetctl", args, { ignoreError: true });
        if (result.exitCode !== 0) {
          core.warning(
            `Failed to start ${g.name}: ${result.stderr || result.stdout}`
          );
        } else {
          core.info(`Started ${instanceName}`);
          state.traceGadgets.push({
            ...g,
            instanceName,
          });
        }
        core.endGroup();
      }
    }

    // Save state for post step
    saveState(state);
    core.info(
      `Runner Insight: ${state.traceGadgets.length} trace gadget(s) running, ${snapshotGadgets.length} snapshot(s) queued for cleanup.`
    );
  } catch (error) {
    core.setFailed(`runner-insight failed: ${error.message}`);
  }
}

function installIg(version) {
  // Determine version
  let ver = version;
  if (ver === "latest") {
    ver = execSync(
      "curl -s https://api.github.com/repos/inspektor-gadget/inspektor-gadget/releases/latest | jq -r '.tag_name'",
      { encoding: "utf8" }
    ).trim();
  }
  if (!ver.startsWith("v")) ver = `v${ver}`;

  // Determine arch
  const arch = os.arch() === "x64" ? "amd64" : "arm64";
  const url = `https://github.com/inspektor-gadget/inspektor-gadget/releases/download/${ver}/ig-linux-${arch}-${ver}.tar.gz`;

  core.info(`Downloading ig ${ver} for linux/${arch}...`);
  execSync(`curl -sSL "${url}" -o /tmp/ig.tar.gz && tar -xzf /tmp/ig.tar.gz -C /tmp ig`, {
    stdio: "inherit",
  });
  execSync("sudo install /tmp/ig /usr/local/bin/ig && rm -f /tmp/ig /tmp/ig.tar.gz", {
    stdio: "inherit",
  });

  const result = sudo("ig", ["version"], { ignoreError: true });
  core.info(`ig version: ${result.stdout}`);
}

function startDaemon(state) {
  // Write ig config enabling the logs operator
  const config = `operator:
  logs:
    enabled: true
    channel: file
    filename: ${state.logFile}
    format: json
    mode: detached
`;
  fs.writeFileSync(configFile(), config);
  core.info(`Config written to ${configFile()}`);

  // Start daemon in background using nohup + shell
  const pidFile = `${state.outputDir}/daemon.pid`;
  execSync(
    `sudo bash -c 'nohup ig daemon --config ${configFile()} > ${state.outputDir}/daemon.log 2>&1 & echo $! > ${pidFile}'`,
    { stdio: "inherit" }
  );

  // Wait for socket
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(SOCKET_PATH)) {
      core.info("ig daemon is ready.");
      try {
        return parseInt(fs.readFileSync(pidFile, "utf8").trim());
      } catch {
        return null;
      }
    }
    execSync("sleep 0.5");
  }

  core.warning("ig daemon socket not found after 10s, proceeding anyway.");
  try {
    return parseInt(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return null;
  }
}

main();
