# Monitor asynchronous spawn error regression — expected RED

Independent test author: runtime_tests. Source baseline: 00177b900b0959cf012d8ac8511765d4bd51f559, before runner error handling.

A captured fake ChildProcess emits an ordinary injected EAGAIN error after run() returns. No actual process or resource exhaustion is used. The public runner must consume that child event, reject the captured exitPromise with the original startup failure (rather than reporting a successful null close), and permit ordinary finished-handle cleanup. Baseline installs no error listener: EventEmitter throws the failure out of the child event and the close later resolves the exitPromise. Expected one behavioral RED; the original sealed fourteen tests remain byte-identical.
