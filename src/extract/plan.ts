/**
 * Two-phase extraction: the walk produces a PLAN (finished native elements, pending export jobs,
 * groups); jobs then run with limited concurrency and the plan is assembled into IR elements in
 * paint order. This keeps exports parallel while the element order stays deterministic.
 */
import type { Element, GroupElement } from '../ir/types';
import { transformBounds, unionRects, cleanRect } from './geometry';
import { runPool, type CancelCheck } from './pool';

export interface Job {
  /** Human-readable label (progress / debugging). */
  label: string;
  run: () => Promise<Element[]>;
}

export type Plan =
  | { kind: 'element'; element: Element }
  | { kind: 'job'; job: Job }
  | { kind: 'group'; id: string; name: string; children: Plan[] };

export const planElement = (element: Element): Plan => ({ kind: 'element', element });
export const planJob = (label: string, run: () => Promise<Element[]>): Plan => ({ kind: 'job', job: { label, run } });

function collectJobs(plans: readonly Plan[], out: Job[]): Job[] {
  for (const p of plans) {
    if (p.kind === 'job') out.push(p.job);
    else if (p.kind === 'group') collectJobs(p.children, out);
  }
  return out;
}

/** Axis-aligned union of the elements' bounds, as a group transform. */
export function groupTransform(children: readonly Element[]): GroupElement['transform'] {
  const u = unionRects(children.map((c) => transformBounds(c.transform))) ?? { x: 0, y: 0, w: 0, h: 0 };
  const r = cleanRect(u);
  return { x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0, flipH: false, flipV: false };
}

function assemble(plans: readonly Plan[], results: Map<Job, Element[]>, preserveGroups: boolean): Element[] {
  const out: Element[] = [];
  for (const p of plans) {
    if (p.kind === 'element') out.push(p.element);
    else if (p.kind === 'job') out.push(...(results.get(p.job) ?? []));
    else {
      const children = assemble(p.children, results, preserveGroups);
      if (preserveGroups && children.length >= 2) {
        out.push({ type: 'group', id: p.id, name: p.name, transform: groupTransform(children), opacity: 1, shadow: null, children });
      } else out.push(...children);
    }
  }
  return out;
}

/** Run every job of the plan (limited concurrency) and assemble the elements in paint order. */
export async function executePlan(
  plans: readonly Plan[],
  options: {
    concurrency: number;
    preserveGroups: boolean;
    isCancelled?: CancelCheck;
    onJobDone?: (done: number, total: number) => void;
  },
): Promise<Element[]> {
  const jobs = collectJobs(plans, []);
  const outputs = await runPool(
    jobs.map((j) => () => j.run()),
    options.concurrency,
    options.isCancelled,
    options.onJobDone,
  );
  const results = new Map<Job, Element[]>();
  jobs.forEach((j, i) => results.set(j, outputs[i]));
  return assemble(plans, results, options.preserveGroups);
}

/** Makes element ids unique across a deck (suffix `#n` on repeats), recursing into groups. */
export class IdRegistry {
  private readonly used = new Set<string>();

  unique(id: string): string {
    if (!this.used.has(id)) {
      this.used.add(id);
      return id;
    }
    let n = 2;
    while (this.used.has(`${id}#${n}`)) n++;
    const out = `${id}#${n}`;
    this.used.add(out);
    return out;
  }

  apply(elements: Element[]): void {
    for (const el of elements) {
      el.id = this.unique(el.id);
      if (el.type === 'group') this.apply(el.children);
    }
  }
}
