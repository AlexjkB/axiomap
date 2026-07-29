#!/usr/bin/env node
/**
 * Pre-commit guard (AXIOMAP.md §5).
 *
 * `.gitignore` only affects untracked files: it will not save you from `git add
 * -f`, from a path nobody listed, or from a fixture directory that did not exist
 * when the rules were written. This tool gets pointed at confidential client
 * code, so ignoring is not enough — this hook blocks.
 *
 * It is advisory-with-override on purpose. A guard people cannot bypass gets
 * deleted; one they must consciously bypass gets read.
 *
 *   AXIOMAP_ALLOW_COMMIT=1 git commit ...   # override, keeps the hook
 *   git commit --no-verify ...              # skips every hook
 */
import { execFileSync } from 'node:child_process';

/** The five public fixtures (§14). `fixtures/client/` is never committable. */
const PUBLIC_FIXTURES = ['minimal', 'inheritance', 'defi', 'pathological', 'large'];

const MAX_BYTES = 1_000_000;

/** Files whose whole point is long opaque strings. Content scanning skips them. */
const ENTROPY_EXEMPT = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;

const SECRET_PATTERNS = [
  { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'private key hex', re: /\b(?:0x)?[0-9a-fA-F]{64}\b/ },
  { name: 'RPC url with key', re: /https?:\/\/[^\s"']*(?:infura|alchemy|quiknode)[^\s"']*/i },
];

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

function stagedPaths() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
}

function stagedSize(path) {
  try {
    return Number(git(['cat-file', '-s', `:${path}`]).trim());
  } catch {
    return 0;
  }
}

function stagedContent(path) {
  try {
    return execFileSync('git', ['cat-file', 'blob', `:${path}`], { maxBuffer: MAX_BYTES * 4 })
      .toString('utf8');
  } catch {
    return '';
  }
}

/** Shannon entropy in bits per character. */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const errors = [];
const warnings = [];

for (const path of stagedPaths()) {
  if (path.startsWith('fixtures/')) {
    const dir = path.split('/')[1];
    if (!PUBLIC_FIXTURES.includes(dir)) {
      errors.push(
        `${path}: fixtures/${dir}/ is not a public fixture. ` +
          `Only ${PUBLIC_FIXTURES.join(', ')} may be committed — client code never is.`,
      );
      continue;
    }
  }

  const size = stagedSize(path);
  if (size > MAX_BYTES) {
    errors.push(
      `${path}: ${(size / 1e6).toFixed(1)} MB staged, limit is ${MAX_BYTES / 1e6} MB. ` +
        'Derived artifacts (graph.json, caches, dumps) do not belong in git.',
    );
    continue;
  }

  if (path.endsWith('.sol')) {
    const allowed =
      path.startsWith('fixtures/') || /^packages\/[^/]+\/test\//.test(path);
    if (!allowed) {
      errors.push(
        `${path}: .sol files are only allowed under fixtures/ or packages/*/test/. ` +
          'Solidity anywhere else is probably code we do not own.',
      );
      continue;
    }
  }

  const content = stagedContent(path);
  if (!content || content.includes('\0') || ENTROPY_EXEMPT.test(path)) continue;

  for (const { name, re } of SECRET_PATTERNS) {
    const match = re.exec(content);
    if (match) {
      const line = content.slice(0, match.index).split('\n').length;
      warnings.push(`${path}:${line}: looks like a ${name}`);
    }
  }

  for (const match of content.matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)) {
    if (entropy(match[0]) > 4.5) {
      const line = content.slice(0, match.index).split('\n').length;
      warnings.push(`${path}:${line}: high-entropy string, check it is not a key`);
      break;
    }
  }
}

for (const warning of warnings) {
  console.warn(`  warn  ${warning}`);
}

if (errors.length > 0) {
  console.error('\nCommit blocked by the Axiomap pre-commit guard:\n');
  for (const error of errors) console.error(`  ✖ ${error}`);

  if (process.env['AXIOMAP_ALLOW_COMMIT'] === '1') {
    console.error('\nAXIOMAP_ALLOW_COMMIT=1 set — proceeding anyway.\n');
    process.exit(0);
  }

  console.error(
    '\nIf this is deliberate, re-run with AXIOMAP_ALLOW_COMMIT=1 (or --no-verify).\n',
  );
  process.exit(1);
}
