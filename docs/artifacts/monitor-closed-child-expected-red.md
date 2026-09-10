# Captured child already closed — expected RED

Independent negative control for captured cancellation ownership. After an owned child has physically closed, a retained handle may remain while terminal delivery finishes. A later cancel must join its already-complete close without signalling the stale PID. Existing source still sends SIGTERM before joining. Fake child only; process.kill and child.kill are mocks, so no actual PID is signalled. Prior seventeen seals unchanged.
