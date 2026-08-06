import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/fixtures`, from `packages/vscode/test`. */
export const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures',
);

export function fixture(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}
