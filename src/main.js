const core = require("@actions/core");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const {
  outputDir,
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

    const igVersion = core.getInput("ig-version") || "latest";
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

    // Install ig
    core.startGroup("Installing ig");
    installIg(igVersion);
    core.endGroup();

    const dir = outputDir();
    const state = {
      outputDir: dir,
      useHost,
      snapshotGadgets,
      traceGadgets: [],
    };

    // Start trace gadgets as background processes writing to files
    for (let i = 0; i < traceGadgets.length; i++) {
      const g = traceGadgets[i];
      const outFile = `${dir}/${i}-${g.name}.out`;
      const errFile = `${dir}/${i}-${g.name}.err`;
      const pidFile = `${dir}/${i}-${g.name}.pid`;

      core.startGroup(`Starting trace gadget: ${g.name}`);

      const args = ["ig", "run", g.name, "-o", "columns"];
      if (useHost) args.push("--host");
      args.push(...g.args);

      const cmd = `sudo ${args.map(shellEscape).join(" ")} > ${outFile} 2> ${errFile} & echo $! > ${pidFile}`;
      core.info(`Command: ${cmd}`);

      try {
        execSync(`bash -c '${cmd}'`, { stdio: "inherit" });
        const pid = fs.readFileSync(pidFile, "utf8").trim();
        core.info(`Started ${g.name} (PID: ${pid})`);
        state.traceGadgets.push({
          ...g,
          index: i,
          pid: parseInt(pid),
          outFile,
          errFile,
        });
      } catch (err) {
        core.warning(`Failed to start ${g.name}: ${err.message}`);
      }

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

function installIg(version) {
  let ver = version;
  if (ver === "latest") {
    ver = execSync(
      "curl -s https://api.github.com/repos/inspektor-gadget/inspektor-gadget/releases/latest | jq -r '.tag_name'",
      { encoding: "utf8" }
    ).trim();
  }
  if (!ver.startsWith("v")) ver = `v${ver}`;

  const arch = os.arch() === "x64" ? "amd64" : "arm64";
  const url = `https://github.com/inspektor-gadget/inspektor-gadget/releases/download/${ver}/ig-linux-${arch}-${ver}.tar.gz`;

  core.info(`Downloading ig ${ver} for linux/${arch}...`);
  execSync(
    `curl -sSL "${url}" -o /tmp/ig.tar.gz && tar -xzf /tmp/ig.tar.gz -C /tmp ig`,
    { stdio: "inherit" }
  );
  execSync(
    "sudo install /tmp/ig /usr/local/bin/ig && rm -f /tmp/ig /tmp/ig.tar.gz",
    { stdio: "inherit" }
  );

  const result = sudo("ig", ["version"], { ignoreError: true });
  core.info(`ig version: ${result.stdout}`);
}

function shellEscape(s) {
  if (/^[a-zA-Z0-9_.\/=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

main();
