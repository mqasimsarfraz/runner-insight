# 🔍 Runner Insight

A GitHub Action that runs [Inspektor Gadget](https://github.com/inspektor-gadget/inspektor-gadget) gadgets on CI runners and generates a Job Summary report with rich, filterable results.

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
| `max-rows` | Max rows per gadget in the summary (0 = unlimited) | No | `50` |
| `fail-on-error` | Fail the action if any gadget errors | No | `false` |

## Gadget Configuration

Each line in the `gadgets` input is a gadget name followed by optional [ig flags](https://www.inspektor-gadget.io/docs/latest/). The action controls `-o` (output) and `-t` (timeout), so do not set those.

### Filtering

Use `--filter` for field-based matching or `--filter-expr` for expressions:

```yaml
gadgets: |
  trace_dns --filter 'name~github.com'
  trace_open --failed --filter 'fname~/etc'
  snapshot_process --filter 'comm==node'
```

Filter syntax: `field==value`, `field!=value`, `field~regex`, `field>=value`, etc.

### Field Selection & Sorting

Use `--fields` to control which columns appear, and `--sort` to order results:

```yaml
gadgets: |
  snapshot_process --fields comm,pid,parent.comm --sort pid
  trace_dns --fields name,qtype,rcode,addresses
```

### Other Useful Flags

| Flag | Description |
|------|-------------|
| `--comm <name>` | Filter by process name |
| `--pid <pid>` | Filter by process ID |
| `--failed` | Show only failed events (e.g. trace_open) |
| `--paths` | Show resolved file paths |

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
            snapshot_socket --fields proto,state,src,dst
            trace_dns --filter 'name~github.com'
            trace_open --failed
          timeout: "15"
```

## Job Summary Report

The action generates a rich Job Summary with:
- **Per-gadget sections** showing status (✅ success, ⏱️ timeout, ❌ error) and duration
- **Markdown tables** rendered from structured gadget output
- **Row limits** to keep summaries readable (configurable via `max-rows`)
- **Warnings/errors** in collapsible details

## How It Works

1. Installs the `ig` CLI using [`mqasimsarfraz/setup-ig`](https://github.com/mqasimsarfraz/setup-ig)
2. Parses each gadget line, validates the name, and checks for reserved flags
3. Runs `sudo ig run <gadget> --host -o json -t <timeout> [user flags...]`
4. Converts JSON output to markdown tables for the Job Summary
5. Saves full JSON output for optional artifact upload
