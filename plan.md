# TUI Improvement Plan — v1.1 UI

Status: **APPROVED** (human approved all mockups via question tool 2026-07-10)

## Goal

Improve the opencode-monitor-plugin TUI across four areas the user selected:
richer indicator chip, delivery & queue visibility, polish/animations, and
output preview in-sidebar.

## Design principles
- Dense but not cluttered — status indicator, not main view.
- Respect `animations_enabled` (kv) — no spin when disabled.
- Theme-aware — use `api.theme.current.*` only, no hardcoded colors.
- Idle state should be subtle, not a wall of command hints.
- Output preview is opt-in (expand a row), not always-on.
- Keep the 1s poll; don't over-engineer the update channel.
- Output tail lives in separate per-job files, not the main snapshot.

---

## 1. Foundation: extend status snapshot + per-job tail files

### 1.1 MonitorIndicatorSnapshot v2

```ts
// src/status-store.ts
export interface MonitorIndicatorJob {
  jobID: string;
  kind: JobKind;           // 'bg' | 'mon' | 'loop' | 'sched'
  sessionID: string;
  status: string;           // 'active' | 'complete' | 'completed' | 'failed' | 'cancelled'
  startedAt: number;
  updatedAt: number;
  createdAt: number;        // NEW — for elapsed timer
  deliveryStatus: string;   // NEW — 'pending' | 'delivered' | 'failed'
  hasTail: boolean;         // NEW — whether a tail file exists for this job
}

export interface MonitorIndicatorSnapshot {
  version: 2;               // BUMP from 1
  updatedAt: number;
  jobs: MonitorIndicatorJob[];
  queueDepth: number;        // NEW — IdleQueue pending count
  dedupedCount: number;      // NEW — total deduped deliveries
  coalescedTicks: number;    // NEW — total coalesced loop ticks
  bridgeUp: boolean;         // NEW — bridge health
  queueDropped: number;      // NEW — bridge-down TTL drops
  completedCount: number;    // NEW — completed jobs (retention window)
  failedCount: number;       // NEW — failed jobs
  scheduledPending: number;  // NEW — pending scheduled prompts
}
```

### 1.2 Per-job tail file

Path: `${XDG_RUNTIME_DIR}/opencode-monitor/tail/<scopeHash>/<jobID>.log`

Format: JSON, atomic write (tmp + rename), capped at last 200 lines combined stdout+stderr.

```json
{
  "jobID": "mon_3",
  "updatedAt": 1720620000000,
  "lines": ["[stdout] line1", "[stderr] line2", "..."],
  "truncated": false
}
```

Write cadence: on every output event (`ProcessRunner.on('output')`) AND on job
completion. Cleanup: delete tail file on job dispose. Keep files for active +
recently completed jobs only.

### 1.3 Read path (TUI)

- Main snapshot: existing `readMonitorStatus(scope)` — unchanged call, returns v2.
- Tail file: new `readMonitorTail(scope, jobID)` — reads `<tail>/<scopeHash>/<jobID>.log`.
- TUI only reads the tail file when a row is expanded (lazy load), polled at 1s while expanded.

### 1.4 Tasks
- T1: Extend `MonitorIndicatorSnapshot` + `MonitorIndicatorJob` types (status-store.ts)
- T2: Wire new fields into status write path (index.ts — collect from registry, idle-queue, bridge, scheduler)
- T3: Add `writeMonitorTail` + `readMonitorTail` + tail file lifecycle (status-store.ts, index.ts output handler)
- T4: Backward-compat: `readMonitorStatus` accepts v1 (old plugin) and v2 gracefully

---

## 2. Richer indicator chip (Compact v2)

### Mockup A — active state

```
Current (v1):
  jobs bg_1:bg +2

Proposed (v2):
  ⠹ bg×2 · mon×1 · loop×1  ⏱42s  ⏐4  ⚡bridge↓
```

Breakdown:
- `⠹` — spinner (respects animations_enabled; falls back to `●` if disabled)
- `bg×2 · mon×1 · loop×1` — per-kind colored badges (kindColor: bg=textMuted, mon=warning, loop=success, sched=accent)
- `⏱42s` — elapsed on longest-running active job (muted if <1s)
- `⏐4` — queue depth badge (info color) if >0; omitted if 0
- `⚡bridge↓` — bridge-down dot (error color) if bridgeUp=false; omitted if up

### Mockup A — idle state

```
Current (v1):
  jobs idle

Proposed (v2):
  ○ jobs idle
```

- `○` — muted circle, no spinner, no badges. Single gentle line.
- On hover/select nothing happens (it's a chip, not interactive).

### Slot placement (unchanged)
- `session_prompt_right` — Compact v2
- `home_prompt_right` — Compact v2
- `home_bottom` — Compact v2
- `app_bottom` — Compact v2
- `sidebar_footer` — Compact v2

---

## 3. Sidebar dashboard + output preview (Detail v2)

### Mockup B — collapsed (all rows collapsed)

```
Current (v1):
  ● OpenCode jobs (3 active · bg×2 · mon×1)
  ● bg_1 background running
  ● bg_2 background running
  ● mon_3 monitor running

Proposed (v2):
  ⠹ OpenCode jobs (3 active · 4 queued · 2 done · 1 failed)
  ┌─────────────────────────────────────────┐
  │ ⠹ bg_1  background  running  42s  pend  │
  │ ⠹ bg_2  background  running  17s  pend  │
  │ ⠹ mon_3 monitor     running  3s   pend  │
  └─────────────────────────────────────────┘
  press [space] to expand output · [c] to cancel
```

Header line:
- Spinner if any active, else `○`
- `3 active · 4 queued · 2 done · 1 failed` — totals with theme colors (active=warning, queued=info, done=success, failed=error)

Per-job row:
- `⠹` — spinner (or `●` colored by kind if animations off)
- `bg_1` — jobID (bold)
- `background` — kind title (kindColor)
- `running` — status (statusColor: running=warning, complete=success, failed=error, cancelled=textMuted)
- `42s` — elapsed (createdAt → now), muted, `1m03s` format
- `pend` — deliveryStatus badge (pending=accent, delivered=success, failed=error) — abbreviated

### Mockup B — one row expanded (output tail)

```
  ⠹ OpenCode jobs (3 active · 4 queued · 2 done · 1 failed)
  ┌─────────────────────────────────────────┐
  │ ⠹ bg_1  background  running  42s  pend  │
  │   ┌───────────────────────────────────┐ │
  │   │ [stdout] Building project...      │ │
  │   │ [stdout] Compiling module A       │ │
  │   │ [stdout] Compiling module B       │ │
  │   │ [stdout] Tests: 42 passed, 0 fail │ │
  │   │ [stderr] warning: unused import   │ │
  │   │ [stdout] Build complete            │ │
  │   └───────────────────────────────────┘ │
  │ ⠹ bg_2  background  running  17s  pend  │
  │ ⠹ mon_3 monitor     running  3s   pend  │
  └─────────────────────────────────────────┘
  [space] collapse · [c] cancel · [↑↓] navigate
```

Expanded tail:
- ScrollBox with last ~15 lines (capped, theme-aware: stdout=text, stderr=error)
- `[stdout]`/`[stderr]` prefixes muted
- Only one row expanded at a time (toggle)
- Lazy-loaded: only reads tail file when expanded, polled at 1s while expanded

### Interaction (if keymap feasible)
- `↑`/`↓` — navigate rows (sidebar_content slot only)
- `space` — expand/collapse output tail
- `c` — cancel selected job (calls `/cancel <jobID>`)
- If keymap in sidebar slots is not feasible, fall back to always-collapsed + a hint to use `/cancel`

---

## 4. Polish & animation layer

### 4.1 Spinner registration
```tsx
import { getComponentCatalogue } from '@opentui/solid'
import { registerSpinner } from 'opentui-spinner/solid'

if (!getComponentCatalogue().spinner) registerSpinner()
```
Place at top of tui.tsx (module scope, idempotent).

### 4.2 animations_enabled gate
```tsx
const animationsEnabled = () => api.kv.get('animations_enabled', true)
// In spinner usage:
<Show when={animationsEnabled()} fallback={<text fg={color}>●</text>}>
  <spinner frames={SPINNER_FRAMES} interval={80} color={color} />
</Show>
```

### 4.3 Idle/empty state (Mockup C)

```
Current (v1):
  ○ OpenCode jobs (idle)
  Run background work and deliver results when this session is idle.
  › /background    run a shell command
  › /monitor       watch command output for a regex
  › /loop          repeat an instruction on an interval
  › /schedule      submit one future instruction

Proposed (v2):
  ○ jobs idle
```

- Single line, muted. No wall of text.
- The command hints move to a `/help` or the existing tips slot, not the sidebar.
- Sidebar becomes empty (or a single muted `○ jobs idle`) when no jobs.

### 4.4 Theme-aware dots
- Kind dot: kindColor(theme, kind) — already used, keep
- Status dot: statusColor(theme, status) — already used, keep
- Bridge dot: `bridgeUp ? theme.success : theme.error`
- Queue badge: `theme.info` when >0

### 4.5 Subtle transitions
- Elapsed timer updates every 1s (existing poll) — no extra animation needed
- Spinner frames at 80ms — matches OpenCode built-in
- No fade/opacity transitions (overkill for a status indicator)

---

## 5. Implementation tasks (ordered)

| # | Task | Files | Effort |
|---|------|-------|--------|
| T1 | Extend snapshot types (v2) + backward-compat reader | status-store.ts | Low |
| T2 | Wire new fields into status write (registry, idle-queue, bridge, scheduler) | index.ts | Med |
| T3 | Add tail file write/read + lifecycle (output handler, cleanup on dispose) | status-store.ts, index.ts | Med |
| T4 | Register spinner component (idempotent) | tui.tsx | Low |
| T5 | Compact v2: spinner, badges, elapsed, queue, bridge dot, idle state | tui.tsx | Med |
| T6 | Detail v2: header totals, per-job rows with elapsed + delivery, collapsible tail via ScrollBox | tui.tsx | High |
| T7 | Idle state redesign (remove wall of text) | tui.tsx | Low |
| T8 | Rebuild dist/tui.js, update test snapshot, run tests | scripts/build-tui.mjs, test/ | Low |
| T9 | Manual smoke test on och 1.17.18-RC1 | — | — |

### Validation
- `npm run build` — dist/tui.js compiles
- `npm run typecheck` — clean
- `npm test` — 316+ pass (extend status-store tests for v2 fields)
- Manual: run a monitor job, verify chip shows spinner+elapsed+queue, verify sidebar shows rows, expand a row and see live tail

### Risks
- Tail file writes on every output event could be high-frequency for chatty commands. Mitigate: debounce tail writes to max 1/s per job, or write on a 500ms coalesce.
- Keymap in sidebar slots may not work (untested). Fallback: no keyboard nav, always-collapsed tail, `/cancel` only.
- Snapshot v2 bump must not break old TUI reading v1 — reader handles both.

---

## Mockups summary

### A. Richer chip
```
ACTIVE:  ⠹ bg×2 · mon×1 · loop×1  ⏱42s  ⏐4  ⚡bridge↓
IDLE:    ○ jobs idle
```

### B. Sidebar dashboard
```
COLLAPSED:
  ⠹ OpenCode jobs (3 active · 4 queued · 2 done · 1 failed)
  ┌─────────────────────────────────────────┐
  │ ⠹ bg_1  background  running  42s  pend  │
  │ ⠹ bg_2  background  running  17s  pend  │
  │ ⠹ mon_3 monitor     running  3s   pend  │
  └─────────────────────────────────────────┘

EXPANDED:
  ⠹ OpenCode jobs (3 active · 4 queued · 2 done · 1 failed)
  ┌─────────────────────────────────────────┐
  │ ⠹ bg_1  background  running  42s  pend  │
  │   ┌───────────────────────────────────┐ │
  │   │ [stdout] Building project...      │ │
  │   │ [stdout] Tests: 42 passed, 0 fail │ │
  │   │ [stderr] warning: unused import   │ │
  │   └───────────────────────────────────┘ │
  │ ⠹ bg_2  background  running  17s  pend  │
  │ ⠹ mon_3 monitor     running  3s   pend  │
  └─────────────────────────────────────────┘
```

### C. Idle state
```
  ○ jobs idle
```