/**
 * The main thread's half of §9 rule 6.
 *
 * Owns one worker for the life of the page and one rule about staleness: a
 * response whose id is not the request the caller is still waiting for is
 * dropped. Without it, clicking through three views quickly settles on whichever
 * layout finished last rather than the one you asked for — a bug that only
 * appears on graphs slow enough to matter, which is the whole population this
 * rule exists for.
 *
 * The worker is injected rather than constructed here so the client is testable
 * without a browser; `browserWorker()` is the real one.
 */

import type { ElkRoot } from './elk-graph.js';
import type { LayoutRequest, LayoutResponse } from './worker.js';

/** The part of `Worker` this uses. */
export interface WorkerLike {
  postMessage(message: LayoutRequest): void;
  addEventListener(type: 'message', handler: (event: { data: LayoutResponse }) => void): void;
  terminate(): void;
}

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  /** How long ELK took, for the status bar — §7's exit criterion is responsiveness. */
  ms: number;
}

export class LayoutClient {
  private readonly worker: WorkerLike;
  private next = 1;
  private pending = new Map<number, { resolve: (result: LayoutResult) => void; reject: (error: Error) => void }>();

  constructor(worker: WorkerLike) {
    this.worker = worker;
    this.worker.addEventListener('message', (event) => {
      const response = event.data;
      const waiting = this.pending.get(response.id);
      // Stale: the caller has already asked for something else.
      if (waiting === undefined) return;
      this.pending.delete(response.id);
      if (response.ok) waiting.resolve({ positions: response.positions, ms: response.ms });
      else waiting.reject(new Error(response.message));
    });
  }

  /**
   * Lay one graph out. Any request still in flight is abandoned — its answer
   * would be for a view that is no longer on screen.
   */
  layout(graph: ElkRoot): Promise<LayoutResult> {
    for (const [, waiting] of this.pending) {
      waiting.reject(new Error('superseded'));
    }
    this.pending.clear();

    const id = this.next++;
    return new Promise<LayoutResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, graph });
    });
  }

  dispose(): void {
    this.pending.clear();
    this.worker.terminate();
  }
}

/**
 * The real worker.
 *
 * `new URL(..., import.meta.url)` is the form Vite understands: it bundles
 * `worker.ts` as a separate module worker rather than inlining ELK into the main
 * chunk, which is the difference between rule 6 holding and appearing to.
 */
export function browserWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as WorkerLike;
}
