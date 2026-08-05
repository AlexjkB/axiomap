/**
 * §9 rule 6: **layout in a web worker.**
 *
 * "Render nodes unlaid-out immediately, animate into position when ELK returns.
 * Never block on layout." ELK layered on a few hundred compound nodes is tens to
 * thousands of milliseconds of straight-line JavaScript, and on the main thread
 * that is a frozen viewport — no pan, no zoom, no scroll — for exactly as long.
 *
 * ### Whose worker
 *
 * elkjs owns the worker boundary itself: `elk-api` posts the graph to
 * `elk-worker.min.js` and resolves a promise with the result. This file was
 * first written with a *second* worker around that one — our own module worker
 * importing `elk.bundled.js` — and it did not work: inside a worker, elkjs
 * decides it cannot spawn its own, falls back to a path that this bundling
 * leaves undefined, and throws `o is not a constructor` where nothing on screen
 * could see it. Using the library's own boundary is both correct and less code.
 *
 * What is left here is the part elkjs does not do: **a stale answer is
 * dropped**. Without it, clicking through three views quickly settles on
 * whichever layout finished last rather than the one you asked for — a bug that
 * only appears on graphs slow enough to matter, which is the whole population
 * this rule exists for.
 */

import ELK from 'elkjs/lib/elk-api.js';

import { toPositions, type ElkNode, type ElkRoot } from './elk-graph.js';

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  /** How long ELK took, for the status bar — §7's exit criterion is responsiveness. */
  ms: number;
}

/** The part of elkjs this file uses, so a test can supply one without a browser. */
export interface LayoutEngine {
  layout(graph: ElkRoot): Promise<ElkNode>;
  terminateWorker?: () => void;
}

export class LayoutClient {
  private readonly engine: LayoutEngine;
  private latest = 0;

  constructor(engine: LayoutEngine) {
    this.engine = engine;
  }

  /**
   * Lay one graph out. Any request still in flight is abandoned — its answer
   * would be for a view that is no longer on screen.
   */
  async layout(graph: ElkRoot): Promise<LayoutResult> {
    const id = ++this.latest;
    const started = Date.now();
    const laidOut = await this.engine.layout(graph);
    if (id !== this.latest) throw new Error('superseded');
    return { positions: toPositions(laidOut), ms: Date.now() - started };
  }

  dispose(): void {
    this.engine.terminateWorker?.();
  }
}

/**
 * The real engine.
 *
 * `new URL(..., import.meta.url)` is the form Vite understands: it emits
 * `elk-worker.min.js` as its own asset rather than inlining 1.4 MB of compiled
 * Java into the main chunk, which is the difference between rule 6 holding and
 * appearing to. `test/bundle.test.ts` checks the built output for exactly that.
 */
export function browserEngine(): LayoutEngine {
  return new ELK({
    workerFactory: () =>
      new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url), { type: 'classic' }),
  }) as unknown as LayoutEngine;
}
