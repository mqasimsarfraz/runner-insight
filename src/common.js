const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const GADGET_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function runnerTemp() {
  return process.env.RUNNER_TEMP || os.tmpdir();
}

function outputDir() {
  const dir = path.join(runnerTemp(), "runner-insight");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFile() {
  return path.join(outputDir(), "state.json");
}

function saveState(state) {
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

// Parse a gadget line into { name, args[] } using shell-like splitting.
// Handles quoted strings for filters like --filter 'name~github.com'
function parseGadgetLine(line) {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;

  const args = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  if (args.length === 0) return null;

  const name = args[0];
  if (!GADGET_NAME_RE.test(name)) return null;

  return { name, args: args.slice(1) };
}

// Run a command, return { stdout, stderr, exitCode }
function run(cmd, args = [], { ignoreError = false } = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (err) {
    if (ignoreError) {
      return {
        stdout: (err.stdout || "").toString().trim(),
        stderr: (err.stderr || "").toString().trim(),
        exitCode: err.status || 1,
      };
    }
    throw err;
  }
}

function sudo(cmd, args = [], opts = {}) {
  return run("sudo", [cmd, ...args], opts);
}

function isTrace(name) {
  return name.startsWith("trace_") || name.startsWith("trace-");
}

module.exports = {
  runnerTemp,
  outputDir,
  stateFile,
  saveState,
  loadState,
  parseGadgetLine,
  run,
  sudo,
  isTrace,
  GADGET_NAME_RE,
};
