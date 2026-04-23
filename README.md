# 🔍 Runner Insight

A GitHub Action that runs [Inspektor Gadget](https://github.com/inspektor-gadget/inspektor-gadget) gadgets on CI runners and generates a Job Summary report.

> **Note:** This action only supports **Linux** runners with **sudo** access (GitHub-hosted Ubuntu runners work out of the box).

## Usage

```yaml
- uses: mqasimsarfraz/runner-insight@main
  with:
    gadgets: |
      snapshot_process --fields comm,pid --sort pid
      snapshot_socket
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `ig-version` | Version of ig to install (e.g. `v0.51.1`) | No | `latest` |
| `gadgets` | Newline-separated gadgets with optional ig flags (see below) | **Yes** | — |
| `timeout` | Default timeout in seconds per gadget | No | `10` |
| `host` | Pass `--host` to show host-level data | No | `true` |
| `fail-on-error` | Fail the action if any gadget errors | No | `false` |

## Gadget Configuration

Each line in the `gadgets` input is a gadget name followed by optional [ig flags](https://www.inspektor-gadget.io/docs/latest/). You control exactly what data appears in the report through ig's native flags. The action only reserves `-t` (timeout).

### Show Only What Matters

Use `--fields` to pick columns and `--filter` to narrow results:

```yaml
gadgets: |
  # Only show process name and PID, sorted
  snapshot_process --fields comm,pid --sort pid

  # DNS queries matching github.com — just the interesting fields
  trace_dns --filter 'name~github.com' --fields name,qtype,rcode

  # Only failed file opens
  trace_open --failed --fields fname,error
```

### Filter Syntax

ig supports rich filtering via `--filter`:

| Operator | Meaning | Example |
|----------|---------|---------|
| `==` | Equals | `--filter 'comm==node'` |
| `!=` | Not equals | `--filter 'rcode!=Success'` |
| `~` | Regex match | `--filter 'name~github\.com'` |
| `!~` | Regex not match | `--filter 'fname!~/proc'` |
| `>=` `>` `<=` `<` | Comparison | `--filter 'pid>=1000'` |

Combine multiple filters: `--filter 'comm==node,pid>=1000'`

For complex logic, use `--filter-expr` with the [expr language](https://expr-lang.org/).

### Output Format

The default output is `columns` (human-readable tables). Override with `-o`:

```yaml
gadgets: |
  snapshot_process -o json --fields comm,pid
  trace_dns -o yaml --fields name,rcode
```

## Example

```yaml
name: Runner Insight
on: [push]

jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - uses: mqasimsarfraz/runner-insight@main
        with:
          gadgets: |
            snapshot_process --fields comm,pid --sort pid
            snapshot_socket --fields src,dst,state
            trace_dns --filter 'name~github.com' --fields name,qtype,rcode
            trace_open --failed --fields fname,error
          timeout: "15"
```

## How It Works

1. Installs the `ig` CLI using [`mqasimsarfraz/setup-ig`](https://github.com/mqasimsarfraz/setup-ig)
2. Parses each gadget line with proper shell quoting (handles `--filter 'name~foo'`)
3. Runs `sudo ig run <gadget> -t <timeout> [--host] [user flags...]`
4. Renders the output in the Job Summary as collapsible sections
