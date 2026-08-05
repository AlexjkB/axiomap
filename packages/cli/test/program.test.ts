/**
 * The argument wiring (§12's surface, `commander` per §3).
 *
 * `commands.test.ts` covers what each command does; this covers that the
 * command line reaches it — the flags, the positionals, the exit codes, and the
 * stdout/stderr split that makes `axiomap export ... > file` and
 * `axiomap query ... | jq` work.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildProgram, run, type Io } from '../src/program.js';
import { plain } from './plain.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-program-'));
  fs.cpSync(path.join(REPO, 'fixtures/minimal'), root, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Invocation {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Invocation> {
  let out = '';
  let err = '';
  const io: Io = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };
  const code = await run(argv, io);
  return { code, out: plain(out), err: plain(err) };
}

describe('help and discovery', () => {
  it('lists every §12 command', async () => {
    const { out, code } = await cli('--help');
    expect(code).toBe(0);
    for (const command of [
      'build',
      'stats',
      'diff',
      'query',
      'export',
      'review',
      'import-findings',
      'serve',
    ]) {
      expect(out).toContain(command);
    }
  });

  it('an unknown command fails with a usable code, not a stack trace', async () => {
    const { code, err } = await cli('frobnicate');
    expect(code).toBe(2);
    expect(err).toContain('unknown command');
  });

  it('serve takes its own options as well as the common ones', () => {
    // Phase 7b turned this command from a refusal into a server, so it can no
    // longer be run to completion here — `serve.test.ts` starts a real one.
    // What this checks is the wiring: the options exist, including §13's
    // `--config`, which is what carries `renderCap` into the UI.
    const program = buildProgram({ out: () => {}, err: () => {} }, { code: 0 });
    const serve = program.commands.find((command) => command.name() === 'serve');
    const flags = (serve?.options ?? []).map((option) => option.flags);
    expect(flags).toEqual(
      expect.arrayContaining([
        '--port <n>',
        '--host <host>',
        '--no-open',
        '-c, --config <file>',
        '--rebuild',
      ]),
    );
  });
});

describe('flags reach the command', () => {
  it('build takes the project as a positional or as --path', async () => {
    const positional = await cli('build', root, '--json');
    expect(positional.code).toBe(0);
    const flagged = await cli('build', '--path', root, '--json');
    expect(flagged.code).toBe(0);
    expect(JSON.parse(positional.out)).toMatchObject({ mode: expect.any(String) as unknown });
  }, 120_000);

  it('--json output is parseable and lands on stdout alone', async () => {
    const { out, err, code } = await cli('query', 'externals', '--path', root, '--json');
    expect(code).toBe(1);
    expect(out.startsWith('{')).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
    // Nothing may contaminate the pipe.
    expect(err).toBe('');
  }, 120_000);

  it('export writes the graph to stdout and its own chatter nowhere near it', async () => {
    const { out, err } = await cli('export', '--path', root, '--format', 'dot');
    expect(out.startsWith('// axiomap export')).toBe(true);
    expect(out).toContain('digraph axiomap {');
    expect(err).toBe('');
  }, 120_000);

  it('rejects a non-numeric --depth instead of silently taking NaN hops', async () => {
    const { code } = await cli('query', 'callers-of', 'Vault.deposit', '--path', root, '--depth', 'lots');
    expect(code).toBe(2);
  }, 120_000);

  it('reports a command error on stderr with exit 2', async () => {
    const { code, err, out } = await cli('query', 'nonsense', '--path', root);
    expect(code).toBe(2);
    expect(err).toContain('error');
    expect(out).toBe('');
  }, 120_000);

  it('--no-enrich builds the syntactic graph deliberately', async () => {
    const { out, code } = await cli('build', root, '--no-enrich', '--json');
    expect(code).toBe(0);
    expect((JSON.parse(out) as { generator: { compilers: string[] } }).generator.compilers).toEqual(
      [],
    );
  }, 120_000);
});

describe('exit codes are the CI contract (§15\'s eighth item)', () => {
  it('0 for nothing found, 1 for something found, 2 for could not run', async () => {
    // Nothing has been reviewed in this throwaway copy, so this is the empty
    // case; `minimal/` does have payable externals, which is the found case.
    expect((await cli('query', 'stale-reviews', '--path', root)).code).toBe(0);
    expect((await cli('query', 'externals', '--path', root)).code).toBe(1);
    expect((await cli('query', 'callers-of', 'NoSuchFunction', '--path', root)).code).toBe(2);
  }, 120_000);
});
