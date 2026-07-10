# OpenCode background/monitor/loop/schedule plugin

OpenCode plugin for background automation jobs. It provides slash commands, AI-callable tools, idle-aware result delivery, and a TUI status indicator.

## Prerequisites

This plugin requires **och** (OpenCode >= 1.17.11-RC1) with the OpenTUI 0.4.x plugin runtime. OpenTUI 0.4+ no longer Solid-transforms `.tsx` files under `node_modules`, so this package ships a precompiled `dist/tui.js` as the public TUI entry.

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

Use this section when adding the plugin to an OpenCode harness/config repository. Run `npm install` from the same directory that owns the `opencode.json` and `tui.json` files, because the config examples below use relative `./node_modules/...` paths. For the default global OpenCode config, that directory is `~/.config/opencode`.

### 1. Install package from GitHub

```bash
cd ~/.config/opencode
npm install github:Shodocan/opencode-monitor-plugin
```

This is a GitHub npm dependency. It is not published to the npm registry yet.

Pin a branch, tag, or commit in shared harnesses when reproducibility matters:

```bash
cd ~/.config/opencode
npm install github:Shodocan/opencode-monitor-plugin#<tag-or-commit>
```

The GitHub install runs `npm run prepare`, which builds `dist/`.

Use direct installed file paths in OpenCode config. Bare package subpaths like `opencode-monitor-plugin/tui` can be treated by OpenCode as packages to install, so GitHub-installed packages should be referenced through `./node_modules/...` from the config directory.

Installed entrypoints:

- `./node_modules/opencode-monitor-plugin/dist/index.js` -> server plugin.
- `./node_modules/opencode-monitor-plugin/dist/tui.js` -> TUI plugin (precompiled Solid universal ESM).

**Why `dist/tui.js` instead of `src/tui.tsx`:** OpenTUI 0.4+ does not Solid-transform package sources under `node_modules`; this package ships a precompiled Solid universal ESM entry at `dist/tui.js`.

### 2. Register server plugin in `opencode.json`

Add the server entrypoint to the normal OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./node_modules/opencode-monitor-plugin/dist/index.js"
  ]
}
```

### 3. Register TUI plugin in `tui.json`

Add the TUI entrypoint to the OpenCode TUI config:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./node_modules/opencode-monitor-plugin/dist/tui.js"
  ],
  "plugin_enabled": {
    "opencode-monitor-indicator": true
  }
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

Register the TUI plugin entry in `tui.json`. Prefer the precompiled entry after build:

```json
{
  "plugin": ["./dist/tui.js"]
}
```

For package-based installs under `~/.config/opencode`, use
`./node_modules/opencode-monitor-plugin/dist/tui.js`. Pointing at `src/tui.tsx`
only works when that path is **outside** `node_modules` (OpenTUI 0.4+ skips
Solid transforms under `node_modules`).

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

Current suite covers parsers, registry, runner/ReDoS, monitor engine, bridge queues/server, notifier, plugin handlers, TUI build output, and integration behavior.

## Support

For issues, questions, or support: [wdcasonatto@gmail.com](mailto:wdcasonatto@gmail.com)