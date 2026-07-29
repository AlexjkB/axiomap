import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The permitted dependency graph (AXIOMAP.md §5) is:
 *
 *   cli → core,  vscode → core + webview,  webview → core (types only)
 *
 * and `core` imports nothing from the workspace. §5 requires a violation to fail
 * CI rather than be noticed in review, so the rule itself needs a test — a lint
 * rule that quietly stops matching is exactly the failure this guards against.
 *
 * `lintText` with a `filePath` exercises the real flat-config path matching
 * without writing probe files into the packages.
 */
const eslint = new ESLint();

async function messagesFor(pkg: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: `packages/${pkg}/src/__direction_probe__.ts`,
  });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports')
    .map((m) => m.message);
}

describe('dependency directions', () => {
  it('rejects core → webview', async () => {
    const messages = await messagesFor('core', `import { x } from '@axiomap/webview';\nx;\n`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Dependency direction violation/);
  });

  it('rejects core → webview via a relative path', async () => {
    const messages = await messagesFor('core', `import { x } from '../../webview/src/bridge.js';\nx;\n`);
    expect(messages).toHaveLength(1);
  });

  it.each([
    ['core', '@axiomap/cli'],
    ['core', '@axiomap/vscode'],
    ['cli', '@axiomap/webview'],
    ['cli', '@axiomap/vscode'],
    ['webview', '@axiomap/cli'],
    ['webview', '@axiomap/vscode'],
    ['vscode', '@axiomap/cli'],
  ])('rejects %s → %s', async (pkg, specifier) => {
    const messages = await messagesFor(pkg, `import { x } from '${specifier}';\nx;\n`);
    expect(messages).toHaveLength(1);
  });

  it('rejects a value import of core from webview', async () => {
    const messages = await messagesFor('webview', `import { AXIOMAP_DIR } from '@axiomap/core';\nAXIOMAP_DIR;\n`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/types only/);
  });

  it.each([
    ['cli', `import { AXIOMAP_DIR } from '@axiomap/core';\nAXIOMAP_DIR;\n`],
    ['vscode', `import { AXIOMAP_DIR } from '@axiomap/core';\nAXIOMAP_DIR;\n`],
    ['vscode', `import type { HostBridge } from '@axiomap/webview';\nexport type A = HostBridge;\n`],
    ['webview', `import type { X } from '@axiomap/core';\nexport type A = X;\n`],
  ])('allows %s → the packages it may depend on', async (pkg, code) => {
    expect(await messagesFor(pkg, code)).toEqual([]);
  });
});
