# Established-child error — expected RED

The pid-undefined asynchronous spawn-error fix currently rejects exitPromise for every ChildProcess error event. A fake established child with a PID must consume an error event without mistaking it for physical exit; its captured completion and cancel remain pending until close. All process.kill calls are mocked before using the synthetic PID; no OS signal is sent. One independent negative-control regression, preserving the existing spawn-error test and earlier seals.
