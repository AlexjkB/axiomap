import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Dependency directions (§5) are enforced, not conventional.
 *
 *   cli     → core
 *   vscode  → core + webview
 *   webview → core (types only)
 *   core    → nothing
 *
 * Each package forbids the workspace names it may not import, plus the relative
 * paths that would sneak around the package boundary (`../../core/src/...`).
 */
/** Patterns that reach into another package by path rather than by name. */
function pathPatternsFor(pkg) {
  return [`**/packages/${pkg}/**`, `../${pkg}/**`, `../../${pkg}/**`];
}

function forbid(forbidden, message) {
  return forbidden.flatMap((pkg) => [
    { group: [`@axiomap/${pkg}`, `@axiomap/${pkg}/**`], message },
    { group: pathPatternsFor(pkg), message },
  ]);
}

function directionRule(pkg, forbidden, typeOnly = []) {
  const message = `Dependency direction violation (AXIOMAP.md §5): ${pkg} must not import this package.`;
  const patterns = forbid(forbidden, message);

  for (const dep of typeOnly) {
    patterns.push({
      group: [`@axiomap/${dep}`, `@axiomap/${dep}/**`],
      allowTypeImports: true,
      message: `Dependency direction violation (AXIOMAP.md §5): ${pkg} may import ${dep} types only — use \`import type\`.`,
    });
  }

  return {
    files: [`packages/${pkg}/**/*.{ts,tsx}`],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns }],
    },
  };
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '.turbo/**',
      '**/coverage/**',
      'fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // core imports nothing from the workspace.
  directionRule('core', ['webview', 'cli', 'vscode']),
  // cli → core only.
  directionRule('cli', ['webview', 'vscode']),
  // vscode → core + webview.
  directionRule('vscode', ['cli']),
  // webview → core, types only.
  directionRule('webview', ['cli', 'vscode'], ['core']),

  {
    // TypeScript already reports undefined identifiers, and it knows about
    // ambient environments (node, dom) that ESLint's globals list does not.
    rules: {
      'no-undef': 'off',
    },
  },
);
