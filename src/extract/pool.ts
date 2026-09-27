/**
 * Cancellation + limited-concurrency task runner (no Promise.allSettled / AbortController needed).
 */

/** Thrown when the user cancels an export. Recognize it with `isCancelled(e)`. */
export class ExtractCancelledError extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExtractCancelledError';
  }
}

export function isCancelledError(e: unknown): boolean {
  return e instanceof Error && e.name === 'ExtractCancelledError';
}

export type CancelCheck = () => boolean;

export function throwIfCancelled(isCancelled?: CancelCheck): void {
  if (isCancelled && isCancelled()) throw new ExtractCancelledError();
}

/**
 * Runs `tasks` with at most `concurrency` in flight and returns their results in order.
 * Stops starting new tasks after the first failure / cancellation and rethrows it once the running
 * tasks have settled (so temporary nodes created by them are cleaned up before the caller continues).
 */
export async function runPool<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
  isCancelled?: CancelCheck,
  onTaskDone?: (done: number, total: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < tasks.length) {
      const index = next++;
      try {
        throwIfCancelled(isCancelled);
        results[index] = await tasks[index]();
        done++;
        if (onTaskDone) onTaskDone(done, tasks.length);
      } catch (error) {
        if (failure === null) failure = { error };
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.max(1, Math.min(concurrency, tasks.length)); i++) workers.push(worker());
  await Promise.all(workers);
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}
