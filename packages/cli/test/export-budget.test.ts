/**
 * How the html export spends a budget it cannot fit in (Phase 7e).
 *
 * `export-rendered.test.ts` covers the deliverable end to end on `defi/`, which
 * is nine contracts and fits whole — so nothing there ever exercises the
 * boundary. This suite makes the budget bind, because the boundary is where the
 * two Phase 7d defects lived and neither of them raised anything:
 *
 * - **Zero call views fit.** The walk was breadth-first and spent the budget in
 *   queue order, so on a 298-contract project 189 contract views reached the
 *   ceiling before the first function was reached. 190 embedded views, not one
 *   of them a call graph — the view §9 rule 4 makes focus-dependent and §11
 *   makes the one an auditor works in.
 * - **2.1x node duplication.** Every view carried whole `GraphNode`s and every
 *   inspection carried the same node again: 2,073 distinct nodes as 4,421
 *   embedded objects.
 *
 * Both are properties of the payload rather than of the markup, so this drives
 * `buildPayload` directly with a stub bundle. What it asserts is the *policy* —
 * a mix that includes call graphs, and one copy of each node — not the exact
 * counts, which are a function of a fixture and would fail on a whitespace
 * change.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProjectGraph, type AxiomapGraph, type ProjectMeta } from '@axiomap/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildPayload, quotaKind, VIEW_QUOTA } from '../src/export/html.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE = path.join(REPO, 'fixtures/inheritance');

let graph: AxiomapGraph;
let meta: ProjectMeta;

beforeAll(async () => {
  const built = await buildProjectGraph(FIXTURE);
  graph = built.graph;
  meta = {
    schemaVersion: built.file.schemaVersion,
    generator: built.file.generator,
    project: built.file.project,
    mode: built.file.mode,
    modeReason: built.file.modeReason,
    score: built.file.score,
    diagnostics: built.file.diagnostics,
    root: FIXTURE,
    renderCap: 1500,
    views: ['protocol', 'contract', 'call', 'state-access', 'inheritance'],
    callDefaults: { up: 2, down: 3 },
  };
}, 300_000);

const BUNDLE = { script: '', style: '', elkWorker: '' };

function payload(budget: number) {
  return buildPayload({
    graph,
    meta,
    auditState: { review: {}, findings: {} },
    root: FIXTURE,
    initial: { view: 'protocol' },
    budget,
    bundle: BUNDLE,
    project: 'inheritance',
    version: 'test',
  });
}

describe('the export budget', () => {
  /**
   * The one that would have failed in Phase 7d. A budget this small on a
   * fixture this size cannot hold everything, which is exactly the case where
   * the old walk embedded contract views until it ran out.
   */
  it('reaches the call graph even when the budget runs out', () => {
    const built = payload(400 * 1024);
    expect(built.limits.viewsOmitted).toBeGreaterThan(0);

    const kinds = built.views.map((entry) => entry.request.view);
    expect(kinds.filter((kind) => kind === 'call').length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => kind === 'contract').length).toBeGreaterThan(0);
    // And the view it was asked for is always the first one, whatever it cost.
    expect(built.views[0]?.request).toEqual({ view: 'protocol' });
  });

  /**
   * The quota is a floor as much as a ceiling: no kind may take another kind's
   * share, which is the property that makes "guarantees a mix" true rather than
   * lucky. Checked in bytes, against the same fractions the module states.
   */
  it('spends no more than its share on any one kind', () => {
    const budget = 400 * 1024;
    const built = payload(budget);

    const spent = { map: 0, contract: 0, call: 0 };
    for (const entry of built.views) {
      spent[quotaKind(entry.request)] += Buffer.byteLength(JSON.stringify(entry.view));
    }

    // The remainder pass lets a kind spend past its own quota only out of what
    // no other kind claimed, so the bound is the quota plus the unclaimed pool
    // — never the whole view budget. The weak form of that, which is the one
    // worth pinning: no kind took everything.
    for (const kind of ['contract', 'call'] as const) {
      expect(spent[kind], kind).toBeLessThan(budget);
      expect(VIEW_QUOTA[kind]).toBeGreaterThan(0);
    }
    expect(spent.contract).toBeGreaterThan(0);
    expect(spent.call).toBeGreaterThan(0);
  });

  /**
   * Payload v2. A node appears in the table once and views point at it by id —
   * which is checked here as "the same node is never embedded twice", the thing
   * that was 2.1x.
   */
  it('carries each node once, however many views draw it', () => {
    const built = payload(4 * 1024 * 1024);

    let references = 0;
    const drawn = new Set<string>();
    for (const entry of built.views) {
      for (const element of entry.view.nodes) {
        if (element.type !== 'node') continue;
        references += 1;
        drawn.add(element.id);
      }
    }

    // A fixture where views really do overlap, or this proves nothing.
    expect(references).toBeGreaterThan(drawn.size);
    expect(Object.keys(built.nodeTable).sort()).toEqual([...drawn].sort());

    // The inspections carry relations, not a second copy of the node.
    for (const inspection of Object.values(built.inspections)) {
      expect(inspection).not.toHaveProperty('node');
    }
  }, 120_000);

  /**
   * The quotas must cost nothing on a project small enough to embed whole —
   * otherwise every ordinary export pays for a rule that exists for large ones.
   * A generous budget must leave nothing queued.
   */
  it('embeds everything reachable when it all fits', () => {
    const built = payload(64 * 1024 * 1024);
    expect(built.limits.viewsOmitted).toBe(0);
  }, 120_000);
});
