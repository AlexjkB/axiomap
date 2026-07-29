import { AXIOMAP_DIR } from '@axiomap/core';
import type { HostBridge } from '@axiomap/webview';

/**
 * Phase 8 wires the real extension host. Kept dependency-free of the `vscode`
 * API surface for now so Phase 0 builds without the editor's typings.
 */
export function activate(): { artifactDir: string; bridge: HostBridge | undefined } {
  return { artifactDir: AXIOMAP_DIR, bridge: undefined };
}

export function deactivate(): void {
  // no-op until Phase 8
}
