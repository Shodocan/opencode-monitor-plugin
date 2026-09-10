# Monitor 1.2.3 / harness 4.3.1 independent RED contract

Written by the independent test author before adding the regression tests. Baseline: `00177b900b0959cf012d8ac8511765d4bd51f559`. Native runtime remains the qualified `cc0d5814f4f6b6ce1bca088c1fc94d79233c63a208653d142a8784c1bcbd7900`; no generic loader changes are permitted by this task.

Expected behavioral RED:

1. The package's existing public `./server` export points to its helper-rich index. Actual native loading initializes the monitor bridge twice and reports twelve monitor tool IDs instead of exactly six unique IDs. A dedicated server entry must load one factory while preserving the helper API in the index.
2. Public server hooks do not expose native `dispose`. Their legacy `__stop` closes only the bridge and one interval, leaving admitted processes, output listeners, monitor debounce windows, scheduler jobs, idle fallback timers, status/tail writes and submitted delivery promises unowned.
3. Disposal during an awaited health admission currently allows the resumed command to spawn. Disposal must fence new producer work, including work resuming after an await.
4. Disposal must await captured owned work until actual cleanup: held process cancellation/exit, already started delivery, and status/tail I/O. Calling dispose concurrently, including through `__stop`, must be idempotent. A concurrent per-job cancellation must not make disposal lose the physical child.
5. Disposed jobs must not emit a synthetic completion, a delayed monitor window, a scheduled prompt or a later loop tick. Public tools must not admit new jobs after disposal. Another live server instance and its current bridge config must remain operational.
6. A harmless real background command must produce exactly one visible synthetic delivery and one terminal job state. The native acceptance check exercises the unchanged loader through the configured public server entry; direct helper unit tests alone cannot satisfy that gate.

Tests will use owned temporary directories, private generated bridge credentials, deterministic held promises/fake clocks where a timing boundary is the subject, and bounded ordinary local child processes where physical exit is the subject. No provider credentials, production journals, or installed profiles are involved. Existing tests and production source are untouched by the test author. Missing imports, syntax failures and tool environment failures are not accepted as behavioral RED.

Public API intended for tests: `server(input)` returns `dispose(): Promise<void>` and `__stop` as the same lifecycle alias. `createMonitorPlugin(deps)` exposes `dispose(): Promise<void>` to exercise existing dependency seams. No new dependency injection seam is required initially.

## Sealed author evidence

The final suite contains11 lifecycle tests,3 ProcessRunner ownership tests and one explicit actual-native acceptance script. Author RED:14/14 unit cases fail for the documented behavior; native public entry yields2 factory starts and12 monitor tool IDs. See `monitor-release-tests-seal.json` for exact hashes/commands. Source remains unchanged.

Pre-seal fixture corrections: deliver an explicit idle event after the loop tool marks its session busy; allow the real event loop to acknowledge socket close before the pending-disposal oracle; release held gates before cleanup even on RED; install the child SIGTERM handler before READY; require public post-dispose rejection, consistent with its existing throwing API. Initial exploratory failures remain in /tmp logs, and none authorize source edits until independent RED on the final seal.

The ordinary background positive case also exposed a concrete status race: final publish invocation requests completedCount1 but an older write leaves the public file active/0. A separate held-earlier-write case deterministically requires the final disposed snapshot to win, with no active jobs, bridgeUpfalse and scheduledPending0.
