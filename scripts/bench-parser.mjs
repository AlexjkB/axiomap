#!/usr/bin/env node
/**
 * Ingest performance harness.
 *
 * Started life as Phase 1's parser bake-off (§7), running two `SolidityParser`
 * backends through identical work and generating
 * `docs/decisions/0001-parser.md`. That comparison is settled — tree-sitter
 * won, `antlr.ts` is deleted, and the ADR is now a frozen record rather than
 * generated output. What survives is the measurement rig, which is worth
 * keeping because §9 sets a **standing** ingest budget: 200k SLOC parsed and
 * graphed in under 5 seconds warm.
 *
 * Three configurations, because one number would hide where the time goes:
 *
 *   1. `single-cold`   one thread, no cache — raw parser throughput.
 *   2. `parallel-cold` workers, no cache — a fresh checkout, and what every
 *                      `axiomap diff` pays when it graphs a second revision.
 *   3. `parallel-warm` workers, cache populated — the §9 budget, and the case
 *                      that happens all day in an editor.
 *
 * Then one more, added in Phase 5: the **diff** of the resulting graph against
 * itself. §9 sets no budget for that, so the number here is a regression
 * tripwire rather than a spec gate — and it exists because the failure it
 * catches is an order of magnitude rather than a percentage. Phase 5's storage
 * layout pass shipped accidentally O(contracts × nodes) and cost 4.5 seconds
 * here while every correctness fixture stayed green.
 *
 *   node scripts/bench-parser.mjs [--runs 5] [--sloc 200000] [--no-write]
 *
 * Measurements are appended to `docs/perf/ingest.json` so a regression shows up
 * as a diff rather than as a number nobody wrote down. Exits non-zero if the
 * warm run misses §9's budget.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'packages/core/dist/index.js');
const LARGE = path.join(ROOT, 'fixtures/large/generated');
const DATA_PATH = path.join(ROOT, 'docs/perf/ingest.json');

/** §9: "200k SLOC parsed and graphed in under 5 seconds warm." */
const WARM_BUDGET_MS = 5_000;

/**
 * Not a §9 budget — §9 does not set one for `axiomap diff`. A tripwire, set
 * well above the measured value, because what it guards against is a pass that
 * became quadratic, and that shows up as 10x rather than 10%.
 */
const DIFF_TRIPWIRE_MS = 2_500;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const RUNS = flag('runs', 5);
const SLOC = flag('sloc', 200_000);
const WRITE = !argv.includes('--no-write');

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
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'fixtures/large/generate.mjs'), '--sloc', String(SLOC)],
    { stdio: 'inherit' },
  );
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

const CACHE_DIR = path.join(LARGE, '.axiomap', 'cache', 'bench');

/**
 * §9's budget is "parsed **and graphed**", so the timed region covers both
 * halves of §4's diagram down to the usable graph. They are measured
 * separately as well: resolution is single-threaded and the parse is not, so
 * one combined number would hide which half regressed.
 */
async function timeRun({ workers, cacheDir }) {
  const started = performance.now();
  const result = await core.ingestProject(LARGE, {
    cacheDir,
    workers,
    workerEntry: WORKER_ENTRY,
  });
  const ingested = performance.now();
  const built = core.buildGraph({
    project: result.project,
    table: result.table,
    parserId: core.DEFAULT_PARSER_ID,
  });
  const finished = performance.now();
  return {
    millis: finished - started,
    ingestMillis: ingested - started,
    graphMillis: finished - ingested,
    result,
    built,
  };
}

async function measure(label, options, runs) {
  const samples = [];
  const ingestSamples = [];
  const graphSamples = [];
  let last = null;
  let lastGraph = null;
  for (let i = 0; i < runs; i++) {
    const run = await timeRun(options);
    samples.push(run.millis);
    ingestSamples.push(run.ingestMillis);
    graphSamples.push(run.graphMillis);
    last = run.result;
    lastGraph = run.built;
  }
  return {
    label,
    median: median(samples),
    min: Math.min(...samples),
    max: Math.max(...samples),
    samples,
    ingestMedian: median(ingestSamples),
    graphMedian: median(graphSamples),
    workers: last.parseStats.workers,
    cacheHits: last.parseStats.cacheHits,
    contracts:
      last.table.stats.contracts +
      last.table.stats.interfaces +
      last.table.stats.libraries +
      last.table.stats.abstractContracts,
    functions: last.table.stats.functions,
    nodes: lastGraph.file.nodes.length,
    edges: lastGraph.file.edges.length,
    mode: lastGraph.file.mode,
    callConfidence: lastGraph.file.score.calls.confident,
  };
}

const fmt = (ms) => `${ms.toFixed(0)} ms`;

/**
 * The diff of a graph against itself.
 *
 * Every node matches at tier 1, so this measures the half of `axiomap diff`
 * that scales with the *whole* project rather than with the changeset —
 * comparing every node's attributes, keying every edge, and deriving findings
 * over every contract. A real PR-shaped diff changes a fraction of a percent of
 * nodes, so the matcher's inferring tiers stay small and this is the number
 * that matters.
 */
function measureDiff(graph, runs) {
  const samples = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    last = core.diffGraphs(graph, graph);
    samples.push(performance.now() - started);
  }
  return {
    label: 'diff-identical',
    median: median(samples),
    min: Math.min(...samples),
    max: Math.max(...samples),
    samples,
    unchangedNodes: last.nodeSummary.unchanged,
    unchangedEdges: last.edgeSummary.unchanged,
    findings: last.findings.length,
  };
}

async function main() {
  ensureLargeFixture();
  const size = countSloc(LARGE);
  process.stdout.write(
    `fixture: ${size.files} files, ${size.sloc.toLocaleString()} SLOC · ${RUNS} runs each\n\n`,
  );

  fs.rmSync(CACHE_DIR, { recursive: true, force: true });

  const rows = [];
  rows.push(await measure('single-cold', { workers: 1, cacheDir: null }, RUNS));
  rows.push(await measure('parallel-cold', { workers: undefined, cacheDir: null }, RUNS));

  // Populate the cache once, then measure warm runs against it.
  await timeRun({ workers: undefined, cacheDir: CACHE_DIR });
  rows.push(
    await measure('parallel-warm', { workers: undefined, cacheDir: CACHE_DIR }, RUNS),
  );

  for (const row of rows) {
    process.stdout.write(
      `${row.label.padEnd(14)} median ${fmt(row.median).padStart(9)}  ` +
        `(parse ${fmt(row.ingestMedian)}, graph ${fmt(row.graphMedian)}, ` +
        `min ${fmt(row.min)}, max ${fmt(row.max)}, workers ${row.workers})\n`,
    );
  }

  const shape = rows[rows.length - 1];
  process.stdout.write(
    `\ngraph: ${shape.nodes.toLocaleString()} nodes, ${shape.edges.toLocaleString()} edges, ` +
      `mode ${shape.mode}, ${Math.round(shape.callConfidence * 100)}% of call edges confident\n`,
  );

  const warmRun = await timeRun({ workers: undefined, cacheDir: CACHE_DIR });
  const diff = measureDiff(warmRun.built.graph, RUNS);
  process.stdout.write(
    `\n${diff.label.padEnd(14)} median ${fmt(diff.median).padStart(9)}  ` +
      `(min ${fmt(diff.min)}, max ${fmt(diff.max)}, ` +
      `${diff.unchangedNodes.toLocaleString()} nodes and ` +
      `${diff.unchangedEdges.toLocaleString()} edges unchanged, ${diff.findings} findings)\n`,
  );

  fs.rmSync(path.join(LARGE, '.axiomap'), { recursive: true, force: true });

  const warm = rows.find((r) => r.label === 'parallel-warm');
  const withinBudget = warm.median < WARM_BUDGET_MS;
  process.stdout.write(
    `\n§9 warm budget: ${withinBudget ? 'PASS' : 'FAIL'} — ` +
      `${fmt(warm.median)} against ${WARM_BUDGET_MS.toLocaleString()} ms\n`,
  );

  const diffWithinTripwire = diff.median < DIFF_TRIPWIRE_MS;
  process.stdout.write(
    `diff tripwire:  ${diffWithinTripwire ? 'PASS' : 'FAIL'} — ` +
      `${fmt(diff.median)} against ${DIFF_TRIPWIRE_MS.toLocaleString()} ms\n`,
  );

  if (WRITE) {
    const entry = {
      measuredAt: new Date().toISOString(),
      parser: core.DEFAULT_PARSER_ID,
      size,
      runs: RUNS,
      rows,
      diff,
      warmBudgetMs: WARM_BUDGET_MS,
      withinBudget,
      diffTripwireMs: DIFF_TRIPWIRE_MS,
      diffWithinTripwire,
      host: {
        cpu: os.cpus()[0]?.model ?? 'unknown CPU',
        cores: os.cpus().length,
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
      },
    };
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, `${JSON.stringify(entry, null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(ROOT, DATA_PATH)}\n`);
  }

  if (!withinBudget || !diffWithinTripwire) process.exitCode = 1;
}

await main();
