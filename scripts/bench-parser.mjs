#!/usr/bin/env node
/**
 * Phase 1 parser bake-off (§7).
 *
 * Runs both `SolidityParser` backends through identical work and writes
 * `docs/decisions/0001-parser.md`. The gate §7 sets is: full parse of 200k
 * SLOC in under 3 seconds warm, with worker-thread parallelism and a
 * content-hash-keyed disk cache.
 *
 * Four measurements, because a single number would hide the trade:
 *
 *   1. `single-cold`   one thread, no cache — raw parser throughput.
 *   2. `parallel-cold` workers, no cache — a first run on a fresh checkout.
 *   3. `parallel-warm` workers, cache populated — the gate, and the case that
 *                      actually happens all day in an editor.
 *   4. `recovery`      declarations recovered from a file with a syntax error,
 *                      which is decision #1 and not a performance question.
 *
 *   node scripts/bench-parser.mjs [--runs 5] [--sloc 200000] [--no-write]
 *   node scripts/bench-parser.mjs --render-only   # re-render the ADR from
 *                                                 # the last measurements
 *
 * Measurements are persisted to `docs/decisions/0001-parser.json` so the
 * markdown can be regenerated without a thirteen-minute re-measure, and so a
 * reviewer can diff the numbers rather than the prose.
 *
 * The ADR is **not** overwritten once its Status stops saying `proposed` —
 * a decision written by a human is not something a benchmark script gets to
 * clobber. Pass `--force` if that is genuinely what you want.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'packages/core/dist/index.js');
const LARGE = path.join(ROOT, 'fixtures/large/generated');
const FIXTURES = ['minimal', 'inheritance', 'defi', 'pathological'];
const BACKENDS = ['antlr', 'treesitter'];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const RUNS = flag('runs', 5);
const SLOC = flag('sloc', 200_000);
const WRITE = !argv.includes('--no-write');
const RENDER_ONLY = argv.includes('--render-only');
const FORCE = argv.includes('--force');

const ADR_PATH = path.join(ROOT, 'docs/decisions/0001-parser.md');
const DATA_PATH = path.join(ROOT, 'docs/decisions/0001-parser.json');

if (RENDER_ONLY) {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`${path.relative(ROOT, DATA_PATH)} not found. Run the benchmark first.`);
    process.exit(1);
  }
  writeAdr(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
  process.exit(0);
}

if (!fs.existsSync(CORE)) {
  console.error('packages/core/dist not built. Run `pnpm build` first.');
  process.exit(1);
}
const core = await import(CORE);

/** The worker entry only exists in built output; workers are the point here. */
const WORKER_ENTRY = new URL('./parse/worker-entry.js', new URL(`file://${CORE}`));

function ensureLargeFixture() {
  if (fs.existsSync(LARGE)) return;
  process.stdout.write('generating fixtures/large …\n');
  execFileSync(process.execPath, [path.join(ROOT, 'fixtures/large/generate.mjs'), '--sloc', String(SLOC)], {
    stdio: 'inherit',
  });
}

function countSloc(dir) {
  let files = 0;
  let sloc = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sol')) {
        files++;
        sloc += fs
          .readFileSync(full, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '').length;
      }
    }
  };
  walk(dir);
  return { files, sloc };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function cacheDirFor(parserId) {
  return path.join(LARGE, '.axiomap', 'cache', `bench-${parserId}`);
}

async function timeRun(parserId, { workers, cacheDir }) {
  const started = performance.now();
  const result = await core.ingestProject(LARGE, {
    parserId,
    cacheDir,
    workers,
    workerEntry: WORKER_ENTRY,
  });
  const millis = performance.now() - started;
  return { millis, result };
}

async function measure(parserId, label, options, runs) {
  const samples = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    if (options.freshCache && options.cacheDir !== null) {
      fs.rmSync(options.cacheDir, { recursive: true, force: true });
    }
    const { millis, result } = await timeRun(parserId, options);
    samples.push(millis);
    last = result;
  }
  return {
    label,
    parserId,
    median: median(samples),
    min: Math.min(...samples),
    max: Math.max(...samples),
    samples,
    inline: last.parseStats.inline,
    workers: last.parseStats.workers,
    cacheHits: last.parseStats.cacheHits,
    contracts: last.table.stats.contracts + last.table.stats.interfaces + last.table.stats.libraries + last.table.stats.abstractContracts,
    functions: last.table.stats.functions,
  };
}

/** Declarations recovered from each fixture — the correctness half. */
async function symbolCounts(parserId) {
  const out = {};
  for (const fixture of FIXTURES) {
    const result = await core.ingestProject(path.join(ROOT, 'fixtures', fixture), {
      parserId,
      cacheDir: null,
    });
    const s = result.table.stats;
    out[fixture] = {
      contracts: s.contracts + s.interfaces + s.libraries + s.abstractContracts,
      functions: s.functions,
      modifiers: s.modifiers,
      stateVariables: s.stateVariables,
      events: s.events,
      errors: s.errors,
      types: s.structs + s.enums + s.userDefinedValueTypes,
      filesWithErrors: s.filesWithErrors,
    };
  }
  return out;
}

/** Recovery on the one file that does not parse. */
async function recovery(parserId) {
  const parser = core.createParser(parserId);
  const file = 'src/SyntaxError.sol';
  const text = fs.readFileSync(path.join(ROOT, 'fixtures/pathological', file), 'utf8');
  const result = parser.parse(file, text);
  const contracts = result.unit.contracts.length;
  const functions = result.unit.contracts.reduce((n, c) => n + c.functions.length, 0);
  return { contracts, functions, diagnostics: result.diagnostics.length };
}

function fmt(ms) {
  return `${ms.toFixed(0)} ms`;
}

async function main() {
  ensureLargeFixture();
  const size = countSloc(LARGE);
  process.stdout.write(
    `fixture: ${size.files} files, ${size.sloc.toLocaleString()} SLOC · ${RUNS} runs each\n\n`,
  );

  const rows = [];
  const symbols = {};
  const recoveries = {};

  for (const parserId of BACKENDS) {
    fs.rmSync(cacheDirFor(parserId), { recursive: true, force: true });

    rows.push(
      await measure(
        parserId,
        'single-cold',
        { workers: 1, cacheDir: null, freshCache: false },
        RUNS,
      ),
    );
    rows.push(
      await measure(
        parserId,
        'parallel-cold',
        { workers: undefined, cacheDir: null, freshCache: false },
        RUNS,
      ),
    );

    // Populate the cache once, then measure warm runs against it.
    const cacheDir = cacheDirFor(parserId);
    await timeRun(parserId, { workers: undefined, cacheDir });
    rows.push(
      await measure(
        parserId,
        'parallel-warm',
        { workers: undefined, cacheDir, freshCache: false },
        RUNS,
      ),
    );

    symbols[parserId] = await symbolCounts(parserId);
    recoveries[parserId] = await recovery(parserId);

    for (const row of rows.filter((r) => r.parserId === parserId)) {
      process.stdout.write(
        `${parserId.padEnd(11)} ${row.label.padEnd(14)} median ${fmt(row.median).padStart(9)}  ` +
          `(min ${fmt(row.min)}, max ${fmt(row.max)}, workers ${row.workers})\n`,
      );
    }
    process.stdout.write('\n');
  }

  fs.rmSync(path.join(LARGE, '.axiomap'), { recursive: true, force: true });

  if (WRITE) {
    const data = {
      size,
      rows,
      symbols,
      recoveries,
      runs: RUNS,
      host: {
        cpu: os.cpus()[0]?.model ?? 'unknown CPU',
        cores: os.cpus().length,
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
      },
      measuredAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(ROOT, DATA_PATH)}\n`);
    writeAdr(data);
  }
}

function writeAdr(data) {
  if (fs.existsSync(ADR_PATH) && !FORCE) {
    const existing = fs.readFileSync(ADR_PATH, 'utf8');
    if (!/\*\*Status:\*\*\s*proposed/.test(existing)) {
      process.stdout.write(
        `${path.relative(ROOT, ADR_PATH)} has a decided Status; not overwriting. Use --force.\n`,
      );
      return;
    }
  }
  fs.mkdirSync(path.dirname(ADR_PATH), { recursive: true });
  fs.writeFileSync(ADR_PATH, renderAdr(data));
  process.stdout.write(`wrote ${path.relative(ROOT, ADR_PATH)}\n`);
}

function renderAdr({ size, rows, symbols, recoveries, runs, host }) {
  const get = (parserId, label) => rows.find((r) => r.parserId === parserId && r.label === label);
  const line = (label) => {
    const a = get('antlr', label);
    const t = get('treesitter', label);
    const ratio = a && t ? (a.median / t.median).toFixed(2) : '—';
    return `| \`${label}\` | ${fmt(a.median)} | ${fmt(t.median)} | ${ratio}× |`;
  };

  const fixtureRows = FIXTURES.map((fixture) => {
    const a = symbols.antlr[fixture];
    const t = symbols.treesitter[fixture];
    const same = JSON.stringify(a) === JSON.stringify(t);
    return `| \`${fixture}/\` | ${a.contracts} / ${a.functions} / ${a.stateVariables} | ${t.contracts} / ${t.functions} / ${t.stateVariables} | ${same ? 'identical' : '**differs**'} |`;
  }).join('\n');

  const warmA = get('antlr', 'parallel-warm').median;
  const warmT = get('treesitter', 'parallel-warm').median;
  const gate = (ms) => (ms < 3000 ? `**passes** (${fmt(ms)} < 3,000 ms)` : `**fails** (${fmt(ms)})`);

  return `# 0001 — Tolerant parser backend

**Status:** proposed — awaiting sign-off before the losing implementation is deleted.
**Date:** ${new Date().toISOString().slice(0, 10)}
**Phase:** 1

> Generated by \`pnpm bench:parser\`. Re-running overwrites this file.

## Context

§3 leaves the tolerant parser as a benchmark gate between
\`@solidity-parser/parser\` (ANTLR-generated) and \`tree-sitter-solidity\`.
Both sit behind \`SolidityParser\` (\`packages/core/src/parse/interface.ts\`) and
produce the same declaration-level AST, so this compares backends and nothing
else.

§7's gate: **200k SLOC in under 3 seconds warm**, with worker-thread
parallelism and a content-hash-keyed disk cache.

## Method

Fixture: \`fixtures/large/\`, ${size.files} files, ${size.sloc.toLocaleString()} SLOC,
generated from a fixed seed. ${runs} runs per configuration, median reported.
Host: ${host.cpu}, ${host.cores} logical cores, Node ${host.node}, ${host.platform}.

Each configuration runs the full Phase 1 pipeline — detect, enumerate, parse,
build the symbol table — because that is what callers pay for, not the parse
call in isolation.

## Results

### Throughput

| Configuration | \`@solidity-parser/parser\` | \`tree-sitter-solidity\` | ANTLR ÷ tree-sitter |
|---|---|---|---|
${line('single-cold')}
${line('parallel-cold')}
${line('parallel-warm')}

Gate (\`parallel-warm\` under 3,000 ms):

- \`@solidity-parser/parser\`: ${gate(warmA)}
- \`tree-sitter-solidity\`: ${gate(warmT)}

### Agreement on the symbol table

Contracts / functions / state variables per fixture.

| Fixture | ANTLR | tree-sitter | Verdict |
|---|---|---|---|
${fixtureRows}

### Error recovery (\`pathological/src/SyntaxError.sol\`)

The file holds three contracts with a syntax error inside the second. Decision
#1 makes this the criterion that a throughput number cannot outvote.

| | Contracts recovered | Functions recovered | Diagnostics |
|---|---|---|---|
| \`@solidity-parser/parser\` | ${recoveries.antlr.contracts} | ${recoveries.antlr.functions} | ${recoveries.antlr.diagnostics} |
| \`tree-sitter-solidity\` | ${recoveries.treesitter.contracts} | ${recoveries.treesitter.functions} | ${recoveries.treesitter.diagnostics} |

ANTLR's tolerant mode abandons the unit: it recovers no contracts, and not even
the \`pragma\` on line 2. tree-sitter's recovery is local — it inserts the
missing tokens, marks them, and keeps every contract including the two *after*
the error. Both files are pinned by tests in \`packages/core/test/parse.test.ts\`.

## Costs the benchmark does not measure

Two of these favour ANTLR and are not visible in any timing.

- **Native build.** \`tree-sitter\` compiles through \`node-gyp\` at install
  (~30 s here) and needs per-platform prebuilds inside a \`.vsix\`.
  \`@solidity-parser/parser\` is pure JavaScript and installs instantly
  everywhere.
- **\`tree-sitter-solidity\` ships \`yarn\` in its runtime \`dependencies\`.**
  That pulls the whole yarn CLI — and \`http\`, \`https\`, \`net\`, \`dns\` —
  into \`@axiomap/core\`'s production tree, which trips the §3
  network-dependency gate (\`pnpm check:network\`). It is a packaging bug
  upstream, not something Axiomap loads, but §3 is a property auditors verify
  by reading the tree, so "we never call it" is not an answer.
  §16 records \`web-tree-sitter\` plus the \`.wasm\` the grammar package already
  ships as the route that has neither problem.
- **Cold parse is what diff mode pays.** §8 makes diff a day-one constraint,
  and \`axiomap diff\` graphs a second git revision — which is always a cold
  parse, never a cached one. The \`parallel-cold\` row is therefore the cost of
  every diff, not just of a first run.

## Decision

_Pending._ See the Phase 1 report and \`docs/PROGRESS.md\`.

## Consequences

_Pending._
`;
}

await main();
