import { isMainThread, parentPort, workerData } from 'worker_threads';

interface WorkerResult {
  ok: true;
  matched: boolean;
}

interface WorkerError {
  ok: false;
  error: string;
}

type WorkerMessage = WorkerResult | WorkerError;

if (isMainThread === false) {
  const data = workerData as { pattern: string; flags: string; text: string };
  try {
    const re = new RegExp(data.pattern, data.flags);
    const matched = re.test(data.text);
    parentPort?.postMessage({ ok: true as const, matched } satisfies WorkerMessage);
  } catch (err) {
    parentPort?.postMessage(
      { ok: false as const, error: err instanceof Error ? err.message : String(err) } satisfies WorkerMessage,
    );
  }
}
