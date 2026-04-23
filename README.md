# 🔍 Runner Insight

A GitHub Action that runs [Inspektor Gadget](https://github.com/inspektor-gadget/inspektor-gadget) gadgets on CI runners and generates a Job Summary report.

> **Note:** This action only supports **Linux** runners with **sudo** access (GitHub-hosted Ubuntu runners work out of the box).

## Usage

```yaml
- uses: mqasimsarfraz/runner-insight@main
  with:
    gadgets: |
      snapshot_process
      snapshot_socket
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `ig-version` | Version of ig to install (e.g. `v0.51.1`) | No | `latest` |
| `gadgets` | Newline-separated list of gadgets to run | **Yes** | — |
| `timeout` | Timeout in seconds for each gadget | No | `10` |
| `fail-on-error` | Fail the action if any gadget errors | No | `false` |

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
            snapshot_process
            snapshot_socket
            trace_dns
          timeout: "15"
```

The action produces a **Job Summary** with:
- A status table showing each gadget's result and duration
- Collapsible details with the full JSON output per gadget

## How It Works

1. Installs the `ig` CLI using [`mqasimsarfraz/setup-ig`](https://github.com/mqasimsarfraz/setup-ig)
2. Runs each gadget with `sudo ig run <gadget> -o json`
3. Bounds trace gadgets with a configurable timeout
4. Generates a Markdown report written to `$GITHUB_STEP_SUMMARY`
