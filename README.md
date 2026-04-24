# 🔍 Runner Insight

A GitHub Action that runs [Inspektor Gadget](https://github.com/inspektor-gadget/inspektor-gadget) gadgets on CI runners for the **entire job duration** and generates a Job Summary report at the end.

> **Note:** This action only supports **Linux** runners with **sudo** access (GitHub-hosted Ubuntu runners work out of the box).

## Usage

Place the action at the start of your job — trace gadgets run in the background during the entire job, and the report is generated automatically during cleanup:

```yaml
steps:
  - uses: mqasimsarfraz/runner-insight@main
    with:
      gadgets: |
        trace_dns --filter 'name~github.com' --fields name,qtype,rcode
        trace_open --failed --fields fname,error
        snapshot_process --fields comm,pid --sort pid

  - name: Build
    run: make build

  - name: Test
    run: make test

  # Report appears automatically — no extra step needed!
```

## How It Works

The action has two phases:

**At job start (`main`):**
1. Installs the `ig` CLI
2. Starts `ig daemon` with the [logs operator](https://github.com/inspektor-gadget/inspektor-gadget/pull/5410) writing to a file
3. Starts trace gadgets (`trace_*`) in detached mode via `gadgetctl`

**At job cleanup (`post`):**
1. Runs snapshot gadgets (`snapshot_*`)
2. Stops trace gadgets and reads the log file
3. Generates a Job Summary report
4. Cleans up the daemon

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `ig-version` | Version of ig to install (e.g. `v0.51.1`) | No | `latest` |
| `gadgets` | Newline-separated gadgets with optional ig flags | **Yes** | — |
| `host` | Pass `--host` to show host-level data | No | `true` |
| `fail-on-error` | Fail the action if any gadget errors | No | `false` |

## Gadget Types

| Type | Behavior |
|------|----------|
| **Trace** (`trace_*`) | Starts at job begin, collects events throughout, stops at cleanup |
| **Snapshot** (`snapshot_*`) | Runs once during cleanup to capture point-in-time state |

## Gadget Configuration

Each line supports ig's native flags — you control exactly what appears in the report:

```yaml
gadgets: |
  # DNS queries to external domains during CI
  trace_dns --filter 'name~github.com' --fields name,qtype,rcode

  # Failed file opens — catches missing deps, wrong paths
  trace_open --failed --fields fname,error

  # Process snapshot at job end
  snapshot_process --fields comm,pid --sort pid

  # Socket state at job end
  snapshot_socket --fields src,dst,state
```

### Filter Syntax

| Operator | Meaning | Example |
|----------|---------|---------|
| `==` | Equals | `--filter 'comm==node'` |
| `!=` | Not equals | `--filter 'rcode!=Success'` |
| `~` | Regex match | `--filter 'name~github\.com'` |
| `!~` | Regex not match | `--filter 'fname!~/proc'` |

## Example

```yaml
name: CI with Runner Insight
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: mqasimsarfraz/runner-insight@main
        with:
          gadgets: |
            trace_dns --fields name,qtype,rcode
            trace_open --failed --fields fname,error

      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test
```
