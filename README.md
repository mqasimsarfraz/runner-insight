# 🔍 Runner Insight

A GitHub Action that runs [Inspektor Gadget](https://github.com/inspektor-gadget/inspektor-gadget) gadgets on CI runners for the **entire job duration** and generates a Job Summary report at the end.

> **Note:** This action only supports **Linux** runners with **sudo** access (GitHub-hosted Ubuntu runners work out of the box).

## Prerequisites

Install `ig` and `gadgetctl` using [`setup-ig`](https://github.com/mqasimsarfraz/setup-ig) before this action:

```yaml
- uses: mqasimsarfraz/setup-ig@main
```

## Quick Start

Place both actions at the start of your job — trace gadgets run in the background during the entire job, and the report is generated automatically during cleanup:

```yaml
steps:
  - uses: mqasimsarfraz/setup-ig@main
  - uses: mqasimsarfraz/runner-insight@main
    with:
      gadgets: |
        trace_dns --fields name,qtype,rcode,latency_ns
        trace_open --failed --fields fname,error

  # Your normal CI steps — runner-insight observes everything
  - uses: actions/checkout@v4
  - run: npm install
  - run: npm test

  # Report appears automatically — no extra step needed!
```

## How It Works

The action uses the `ig daemon` with the [logs operator](https://www.inspektor-gadget.io/docs/latest/reference/operators/logs) for reliable event collection:

**At job start (`main`):**
1. Verifies `ig` and `gadgetctl` are installed
2. Starts `ig daemon` with the logs operator writing detached gadget data to a file
3. Starts trace/top gadgets in detached mode via `gadgetctl run --detach`

**At job cleanup (`post`):**
1. Stops trace/top gadgets via `gadgetctl delete`
2. Parses the NDJSON log file for collected events
3. Runs snapshot gadgets (`snapshot_*`) with a timeout
4. Generates a Job Summary report
5. Cleans up the daemon

## Recommended Configurations

CI runners experience many of the same issues as production systems — DNS failures, network timeouts, OOM kills, missing files, and mysterious process deaths. Runner Insight surfaces these with zero code changes.

### 🟢 Minimal — Low Overhead

Best for: always-on monitoring with negligible performance impact.

```yaml
gadgets: |
  trace_dns --fields name,qtype,rcode,latency_ns
  trace_open --failed --fields fname,error
```

| Gadget | What it catches |
|--------|----------------|
| `trace_dns` | DNS resolution failures, slow lookups, unexpected domains |
| `trace_open --failed` | Missing files, wrong paths, permission errors |

### 🟡 Recommended — Catches Most CI Issues

Best for: debugging flaky tests and intermittent failures.

```yaml
gadgets: |
  trace_dns --fields name,qtype,rcode,latency_ns
  trace_open --failed --fields fname,error
  trace_tcp --failure-only --fields src,dst,type,error
  trace_oomkill --fields tpid,tcomm,pages
  trace_signal --kill-only --fields sig,tpid,error
  snapshot_process --fields comm,pid --sort pid
  snapshot_socket --fields src,dst,state
```

| Gadget | What it catches |
|--------|----------------|
| `trace_dns` | DNS resolution failures, slow lookups, unexpected domains |
| `trace_open --failed` | Missing files, wrong paths, permission errors |
| `trace_tcp --failure-only` | TCP connection failures — registry timeouts, API unreachable |
| `trace_oomkill` | OOM-killed processes — build/test running out of memory |
| `trace_signal --kill-only` | Processes killed by signals (SIGKILL, SIGTERM) |
| `snapshot_process` | All processes running at job end |
| `snapshot_socket` | All open sockets at job end |

### 🔴 Full — Deep Debugging

Best for: investigating hard-to-reproduce failures with full system visibility.

```yaml
gadgets: |
  trace_dns --fields name,qtype,rcode,latency_ns
  trace_open --failed --fields fname,error
  trace_tcp --failure-only --fields src,dst,type,error
  trace_tcpretrans --fields src,dst,reason,state
  trace_tcpdrop --fields src,dst,reason,state
  trace_oomkill --fields tpid,tcomm,pages
  trace_signal --kill-only --fields sig,tpid,error
  trace_exec --fields exepath,args,error
  trace_sni --fields name
  snapshot_process --fields comm,pid --sort pid
  snapshot_socket --fields src,dst,state
```

| Gadget | What it catches |
|--------|----------------|
| `trace_tcpretrans` | TCP retransmissions — network instability, packet loss |
| `trace_tcpdrop` | Dropped TCP packets with kernel drop reason |
| `trace_exec` | Every process executed — full audit trail of what ran |
| `trace_sni` | TLS Server Name Indication — which HTTPS hosts were contacted |

### Common CI Issues → Gadgets

| CI Problem | Symptom | Gadget |
|-----------|---------|--------|
| DNS failures | `Could not resolve host` | `trace_dns` (check `rcode`) |
| Slow DNS | Intermittent timeouts | `trace_dns` (check `latency_ns`) |
| Network timeouts | `Connection timed out` | `trace_tcp --failure-only` |
| Packet loss | Flaky downloads | `trace_tcpretrans`, `trace_tcpdrop` |
| Missing files | `No such file or directory` | `trace_open --failed` |
| OOM kills | Exit code 137 | `trace_oomkill` |
| Killed processes | Unexpected process death | `trace_signal --kill-only` |
| TLS/registry issues | `SSL handshake failed` | `trace_sni` |

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
| **Top** (`top_*`) | Starts at job begin, periodically aggregates activity, stops at cleanup |
| **Snapshot** (`snapshot_*`) | Runs once during cleanup to capture point-in-time state |

## Gadget Configuration

Each line supports ig's native flags — you control exactly what appears in the report:

```yaml
gadgets: |
  # DNS queries with latency
  trace_dns --fields name,qtype,rcode,latency_ns

  # Only failed file opens — catches missing deps, wrong paths
  trace_open --failed --fields fname,error

  # Only failed TCP connections — catches network issues
  trace_tcp --failure-only --fields src,dst,type,error

  # Process snapshot at job end
  snapshot_process --fields comm,pid --sort pid
```

### Filter Syntax

| Operator | Meaning | Example |
|----------|---------|---------|
| `==` | Equals | `--filter 'comm==node'` |
| `!=` | Not equals | `--filter 'rcode!=Success'` |
| `~` | Regex match | `--filter 'name~github\.com'` |
| `!~` | Regex not match | `--filter 'fname!~/proc'` |

## Available Gadgets

For the full catalog of gadgets, see the [Inspektor Gadget documentation](https://www.inspektor-gadget.io/docs/latest/gadgets/).

## Example

See [runner-insight-example](https://github.com/mqasimsarfraz/runner-insight-example) for a working workflow.
