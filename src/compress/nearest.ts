/**
 * Exact nearest-palette-colour search in the working space, accelerated with a guess.
 *
 * For every palette entry the other entries are pre-sorted by distance. A query starts from a
 * guess g (the previous pixel's colour, the undithered colour, the previous k-means assignment…)
 * and walks g's neighbour list in order of distance; by the triangle inequality an entry n with
 * d(g, n) ≥ d(q, g) + d(q, best) cannot be closer than `best`, so the walk stops there. With a good
 * guess only a handful of distances are computed; the result is always the exact nearest entry.
 */
import { DIM } from './space';

export class NearestSearch {
  readonly size: number;
  private readonly coords: Float64Array;
  private readonly order: Uint16Array;
  private readonly orderDist: Float64Array;
  /** Squared distance of the last `nearest()` result. */
  lastDist2 = 0;

  /** `coords`: `size` × DIM working-space coordinates (copied). */
  constructor(coords: ArrayLike<number>, size: number) {
    if (size < 1 || size > 65535) throw new RangeError(`palette size ${size}`);
    this.size = size;
    this.coords = Float64Array.from({ length: size * DIM }, (_, i) => coords[i]);
    this.order = new Uint16Array(size * size);
    this.orderDist = new Float64Array(size * size);
    const d = new Float64Array(size);
    const idx = new Uint16Array(size);
    const c = this.coords;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const a = i * DIM;
        const b = j * DIM;
        const d0 = c[a] - c[b];
        const d1 = c[a + 1] - c[b + 1];
        const d2 = c[a + 2] - c[b + 2];
        const d3 = c[a + 3] - c[b + 3];
        d[j] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3);
        idx[j] = j;
      }
      idx.sort((p, q) => d[p] - d[q] || p - q);
      const base = i * size;
      for (let k = 0; k < size; k++) {
        this.order[base + k] = idx[k];
        this.orderDist[base + k] = d[idx[k]];
      }
    }
  }

  /** Index of the palette entry nearest to (x0, x1, x2, x3), starting the search from `guess`. */
  nearest(x0: number, x1: number, x2: number, x3: number, guess: number): number {
    const c = this.coords;
    const n = this.size;
    let best = guess >= 0 && guess < n ? guess : 0;
    let o = best * DIM;
    let e0 = x0 - c[o];
    let e1 = x1 - c[o + 1];
    let e2 = x2 - c[o + 2];
    let e3 = x3 - c[o + 3];
    let bestD = e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
    if (bestD === 0 || n === 1) {
      this.lastDist2 = bestD;
      return best;
    }
    const dGuess = Math.sqrt(bestD);
    let limit = dGuess + dGuess;
    const base = best * n;
    const order = this.order;
    const orderDist = this.orderDist;
    for (let k = 1; k < n; k++) {
      if (orderDist[base + k] >= limit) break;
      const j = order[base + k];
      o = j * DIM;
      e0 = x0 - c[o];
      let d = e0 * e0;
      if (d >= bestD) continue;
      e1 = x1 - c[o + 1];
      d += e1 * e1;
      if (d >= bestD) continue;
      e2 = x2 - c[o + 2];
      d += e2 * e2;
      if (d >= bestD) continue;
      e3 = x3 - c[o + 3];
      d += e3 * e3;
      if (d < bestD) {
        bestD = d;
        best = j;
        limit = dGuess + Math.sqrt(d);
      }
    }
    this.lastDist2 = bestD;
    return best;
  }

  /** Brute force (tests / verification). */
  nearestBrute(x0: number, x1: number, x2: number, x3: number): number {
    const c = this.coords;
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < this.size; j++) {
      const o = j * DIM;
      const e0 = x0 - c[o];
      const e1 = x1 - c[o + 1];
      const e2 = x2 - c[o + 2];
      const e3 = x3 - c[o + 3];
      const d = e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return best;
  }
}
