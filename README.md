# opencode Monitor Plugin

Slash-command and custom-tool plugin for opencode automation jobs that wait for the target session to become idle before appending and submitting prompts.

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

## Idle/busy delivery model

The plugin sends delivery requests to a local bridge. The bridge tracks opencode session status notifications:

- `idle`: queued deliveries for that session may flush.
- `busy`, `retry`, or unknown: deliveries stay queued.

The bridge appends through `notifications/opencode/prompt/append` with `{ text, submit: true, sessionID }`. It rechecks session status before each queued append. `/loop` uses latest-only coalescing and adds coalesced tick metadata; `/background`, `/monitor`, and `/schedule` retain full payloads subject to caps.

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

## Installation/configuration

Build the package and register the plugin entry from `dist/index.js` in opencode config:

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
