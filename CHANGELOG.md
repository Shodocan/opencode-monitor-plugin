# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-22

First public release of `opencode-monitor-plugin`.

### Added — core capabilities
- **Background jobs** (`/background` / `opencode_monitor_background`): run a
  shell command without blocking the current assistant turn; the full output is
  delivered to the session when it next goes idle.
- **Monitor** (`/monitor` / `opencode_monitor_monitor`): watch long-running
  command output for regex matches and deliver matched context windows (with
  optional before/after lines and debounce).
- **Loop** (`/loop` / `opencode_monitor_loop`): repeatedly submit a prompt on an
  interval. Missed ticks while the target session is busy coalesce into a
  single delivery annotated with the tick count.
- **Schedule** (`/schedule` / `opencode_monitor_schedule`): submit a prompt once
  at a future time.
- **Jobs** (`/jobs` / `opencode_monitor_jobs`): list active/completed/failed jobs
  for the session.
- **Cancel** (`/cancel` / `opencode_monitor_cancel`): cancel an active job by ID.
- **TUI status indicator**: surface active jobs in the OpenCode
  sidebar/title/footer and prompt-side chip (requires `och`).

### Added — delivery & safety
- **Idle-aware delivery**: all automatic deliveries queue until the target
  OpenCode session is idle, so background results never interrupt an in-flight
  turn.
- **Queue dedup**: while a session is busy, identical queued messages
  (`bg`/`mon`/`sched`) coalesce into one pending entry annotated
  `[deduped N identical messages while session was busy]`, keeping the session
  context clean. `/loop` retains its existing
  `[coalesced N loop ticks while session was busy]` semantics.
- **Bridge-down queue**: when the local MCP bridge is unavailable, deliveries
  fall back to a TTL-bounded (10-minute) queue that drops duplicate payloads
  and replays survivors once the bridge recovers.
- **Output sanitization**: nonce-fenced delivery blocks, ANSI/control-character
  stripping, and best-effort secret redaction for delivered content.
- **ReDoS guard**: monitor regexes are screened for catastrophic backtracking
  before being accepted.

### Changed
- `package.json` license normalized to `MIT` (and the lockfile synced).

### Engineering
- In-memory v1 state only — no daemon or persistent job database.
- Vitest suite (315 tests) covers delivery, queues, dedup, caps, parsers,
  monitor engine, scheduler, bridge server, and end-to-end integration.
- TypeScript ESM build via `tsc -p tsconfig.json`.

### Prerequisites
- Requires **och** (a custom opencode build with MCP/TUI integrations) until
  [anomalyco/opencode#30019](https://github.com/anomalyco/opencode/pull/30019)
  merges upstream. Standard opencode does not yet support the TUI plugin
  system or MCP notification channels used by this plugin.
- Node `>=22`, opencode `>=1.15.0`.