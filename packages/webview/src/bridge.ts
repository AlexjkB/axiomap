import type { EnsureAxiomapDirResult } from '@axiomap/core';

/**
 * The webview never receives the full graph (AXIOMAP.md §9 rule 1). It requests
 * subgraphs over a transport that differs by host: `postMessage` in VS Code, a
 * local HTTP endpoint under `axiomap serve`.
 *
 * Phase 7 fills this in. The type-only import above is deliberate: webview may
 * depend on core's types and nothing else.
 */
export interface HostBridge {
  request(view: string, params: Record<string, unknown>): Promise<unknown>;
}

export type WorkspaceInfo = Pick<EnsureAxiomapDirResult, 'dir'>;
