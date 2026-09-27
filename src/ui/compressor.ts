/**
 * The app's compressor: the bundled worker (scripts/build.mjs injects its source as the virtual
 * module `figmadeck:compress-worker`), falling back to the main thread. Browser bundle only — tests
 * use CompressorClient / inThreadCompressor directly.
 */
import workerCode from 'figmadeck:compress-worker';
import { CONFIG } from '../config';
import { CompressorClient, browserWorkerFactories } from './compress-client';

export function createCompressor(): CompressorClient {
  const ways = ['blob: URL', 'data: URL'];
  return new CompressorClient(browserWorkerFactories(workerCode), {
    onStartFailure: (i, reason) => console.warn(`${CONFIG.meta.productName}: compression worker (${ways[i] ?? i}) unavailable: ${reason}`),
  });
}
