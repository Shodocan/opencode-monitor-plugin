# OpenCode background/monitor/loop/schedule plugin

OpenCode plugin for background automation jobs. It provides slash commands, AI-callable tools, idle-aware result delivery, and a TUI status indicator.

## Prerequisites

This plugin requires **och**, a custom opencode build with MCP/TUI integrations. Today, **och is just opencode plus [anomalyco/opencode#30019](https://github.com/anomalyco/opencode/pull/30019)** until that PR is merged upstream. Standard opencode does not yet support the TUI plugin system or MCP notification channels used by this plugin.

If this plugin is useful to you, please help by upvoting/supporting [anomalyco/opencode#30019](https://github.com/anomalyco/opencode/pull/30019) so these hooks can land in upstream opencode.

**Install och (Linux x64):**
```bash
curl -fsSL https://s3.casonatto.dev/shared/opencode-custom/install.sh | sh
```

**Full documentation:** https://s3.casonatto.dev/shared/opencode-custom/opencode-custom-hindsight-install.md

## Capabilities

- Run long shell commands without blocking the current assistant turn.
- Watch long-running command output for regex matches and deliver matched windows.
- Schedule one-shot prompts for later.
- Run repeated prompt loops; missed ticks while the target session is busy coalesce into one delivery.
- Queue all automatic deliveries until the target OpenCode session is idle.
- Show active jobs in the OpenCode TUI sidebar/title/footer and prompt-side chip.
- Cancel active jobs by job ID.
- Keep v1 state in-memory only; no daemon or persistent job database.
- Sanitize delivered output: nonce framing, ANSI/control stripping, and best-effort secret redaction.

## Commands

- `/background <command>`: run `/bin/sh -c <command>` and deliver the final capped tail output after exit.
- `/monitor --regex <pattern> [--before N] [--after N] [--debounce S] -- <command>`: run a command and deliver matching output windows.
- `/loop <interval> <prompt>`: repeatedly submit a prompt. Busy-session ticks coalesce into one delivery.
- `/schedule in <duration> <prompt>` or `/schedule at <iso-date> <prompt>`: submit once at a future time.
- `/jobs`: list jobs for the current session only.
- `/cancel <jobID>`: cancel a job owned by the current session.

Slash commands are prompt templates that instruct the model to call the matching tool. The AI-callable tool names are:

- `opencode_monitor_background`
- `opencode_monitor_monitor`
- `opencode_monitor_loop`
- `opencode_monitor_schedule`
- `opencode_monitor_jobs`
- `opencode_monitor_cancel`

## OpenCode harness installation

Use this section when adding the plugin to an OpenCode harness/config repository.

### 1. Install package from GitHub

```bash
npm install github:Shodocan/opencode-monitor-plugin
```

Pin a branch, tag, or commit in shared harnesses when reproducibility matters:

```bash
npm install github:Shodocan/opencode-monitor-plugin#<tag-or-commit>
```

The GitHub install runs `npm run prepare`, which builds `dist/` for the server plugin.

Package entrypoints:

- `opencode-monitor-plugin/server` -> server plugin, compiled from `dist/index.js`.
- `opencode-monitor-plugin/tui` -> compiled TUI plugin from `dist/tui.js`.

### 2. Register server plugin in `opencode.json`

Add the server entrypoint to the normal OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-monitor-plugin/server"
  ]
}
```

### 3. Register TUI plugin in `tui.json`

Add the TUI entrypoint to the OpenCode TUI config:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-monitor-plugin/tui"
  ]
}
```

### 4. Restart OpenCode

Restart OpenCode after changing `opencode.json`, `tui.json`, or the installed package. Plugin config is loaded at startup.

### 5. Smoke test

Start a short monitor from an assistant turn:

```text
Use opencode_monitor_monitor with raw args:
--regex OPENCODE_MONITOR_SMOKE --before 0 --after 0 --debounce 1 -- sh -c "sleep 2; printf 'OPENCODE_MONITOR_SMOKE ok\n'"
```

Expected:

- Tool returns `started mon_N` immediately.
- TUI shows an active monitor job while the command is running.
- After the match, OpenCode receives a visible synthetic prompt with the matched output.

## Idle/busy delivery model

The plugin sends delivery requests to a local bridge. The bridge tracks opencode session status notifications:

- `idle`: queued deliveries for that session may flush.
- `busy`, `retry`, or unknown: deliveries stay queued.

The bridge delivers through hidden-transport visible synthetic prompts with `{ text, sessionID, visible: true }`. Visible synthetic prompts render with the opencode-injected header `◇ MCP · <server-name>`; clients do not provide the caller name. It rechecks session status before each queued delivery. `/loop` uses latest-only coalescing and adds coalesced tick metadata; `/background`, `/monitor`, and `/schedule` retain full payloads subject to caps. The plugin must not use visible prompt append for queued output, because append mutates the user's prompt input.

## Bridge config

`BridgeServer` writes a bearer-token config file to:

1. `OPENCODE_MONITOR_BRIDGE_CONFIG`, if set.
2. `${XDG_RUNTIME_DIR:-<os-temp>}/opencode-monitor/bridge.json`.

Security constraints:

- parent directory mode: `0700`
- config file mode: `0600`
- owner must match the current uid when available
- symlinks are rejected
- HTTP listener is loopback-only
- bearer tokens are 32 random bytes encoded as base64url

## Local development installation

Build the package and register the server plugin entry from `dist/index.js` in opencode config:

```bash
npm install
npm run build
```

Example opencode config fragment:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./dist/index.js"]
}
```

Restart opencode after changing plugin/config files; config is loaded at startup.

Register the TUI plugin entry as `opencode-monitor-plugin/tui` in `tui.json` for package-based validation. For local development, you can point `tui.json` at `src/tui.tsx` or `dist/tui.js` after `npm run build`.

```json
{
  "plugin": ["./src/tui.tsx"]
}
```

The TUI plugin adds a visual running-job indicator in the prompt area plus a collapsible sidebar detail view.

## Pre-release checklist

Before pushing, tagging, or publishing, run:

```bash
npm run typecheck
npm test
npm pack --dry-run
```

Then inspect the pack list and run a secret scan over tracked and package files to ensure no sensitive data is included.

## Limits and safety notes

- Jobs are in-memory only; no daemon persistence in v1.
- Commands run through POSIX `/bin/sh -c`.
- Active jobs cap: 20.
- Completed retention: 50.
- Output tail cap: 200 lines / 32 KiB per stream.
- Monitor debounce: 1–60 seconds; default 5 seconds.
- Loop interval minimum: 10 seconds.
- Schedule horizon maximum: 30 days.
- ReDoS checks run in worker threads with bounded concurrency and timeout.
- Delivery text is nonce-framed, ANSI/control sanitized, and secret-redacted best-effort.

## Validation

```bash
npm test
npm run typecheck
npm run build
```

Current suite covers parsers, registry, runner/ReDoS, monitor engine, bridge queues/server, notifier, plugin handlers, and integration behavior.

## Support

For issues, questions, or support: [wdcasonatto@gmail.com](mailto:wdcasonatto@gmail.com)
