# 🔍 Runner Insight

A GitHub Action that runs [Inspektor Gadget](https://github.com/inspektor-gadget/inspektor-gadget) gadgets on CI runners for the **entire job duration** and generates a Job Summary report at the end.

> **Note:** This action only supports **Linux** runners with **sudo** access (GitHub-hosted Ubuntu runners work out of the box).

## Prerequisites

Install `ig` and `gadgetctl` using [`setup-ig`](https://github.com/mqasimsarfraz/setup-ig) before this action:

```yaml
- uses: mqasimsarfraz/setup-ig@main
```

## Usage

Place both actions at the start of your job — trace gadgets run in the background during the entire job, and the report is generated automatically during cleanup:

```yaml
steps:
  - uses: mqasimsarfraz/setup-ig@main

  - uses: mqasimsarfraz/runner-insight@main
    with:
      gadgets: |
        trace_dns --fields name,qtype,rcode
        trace_open --failed --fields fname,error
        snapshot_process --fields comm,pid --sort pid

  - name: Build
    run: make build

  - name: Test
    run: make test

  # Report appears automatically — no extra step needed!
```

## How It Works

The action uses the `ig daemon` with the [logs operator](https://www.inspektor-gadget.io/docs/latest/reference/operators/logs) for reliable event collection:

**At job start (`main`):**
1. Verifies `ig` and `gadgetctl` are installed
2. Starts `ig daemon` with the logs operator writing detached gadget data to a file
3. Starts trace gadgets (`trace_*`) in detached mode via `gadgetctl run --detach`

**At job cleanup (`post`):**
1. Stops trace gadgets via `gadgetctl delete`
2. Parses the NDJSON log file for trace events
3. Runs snapshot gadgets (`snapshot_*`) with a timeout
4. Generates a Job Summary report
5. Cleans up the daemon

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
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
  # DNS queries during CI
  trace_dns --fields name,qtype,rcode

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
      - uses: mqasimsarfraz/setup-ig@main

      - uses: mqasimsarfraz/runner-insight@main
        with:
          gadgets: |
            trace_dns --fields name,qtype,rcode
            trace_open --failed --fields fname,error
            snapshot_process --fields comm,pid --sort pid

      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test
```
