/**
 * Compression worker entry. Bundled separately by scripts/build.mjs (virtual module
 * `figmadeck:compress-worker`) and started from a blob: / data: URL by src/ui/compress-client.ts.
 * Protocol: src/ui/compress-job.ts (`ready` once, then one `result` / `error` per `compress`).
 */
import { handleWorkerRequest, type WorkerResponse } from './compress-job';

/** The worker global scope, typed locally (the UI project compiles against the DOM lib, not WebWorker). */
interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: WorkerResponse, transfer: ArrayBuffer[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const answer = handleWorkerRequest(event.data);
  if (answer) scope.postMessage(answer.response, answer.transfer);
};

scope.postMessage({ type: 'ready' }, []);
