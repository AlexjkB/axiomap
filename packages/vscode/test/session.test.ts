/**
 * `AxiomapSession` — the extension's model, and the Phase 8b boundary audit's
 * determinism probe on it.
 *
 * It was at 0% coverage, which is worse than it looks: this is the file every
 * other file in the package asks for a graph, and its two interesting
 * properties are both about *not* doing work twice. The audit's question for a
 * phase boundary is whether the same input gives the same answer, so:
 *
 * - **`ready` is idempotent and shared.** The panel, the CodeLens provider and a
 *   cursor move all arrive within a frame of each other on activation. Three
 *   ingests of one project is three times the work for one answer, and — worse
 *   — three graph objects that can drift apart.
 * - **`reload` replaces the state without emptying it first**, so a rebuild
 *   triggered by a save does not blank the panel for the seconds it takes.
 * - **`refreshAuditState` moves the audit state and nothing else**, which is the
 *   whole reason `review.json` is watched separately from `graph.json`.
 */

import { describe, expect, it } from 'vitest';

import { AxiomapSession } from '../src/session.js';
import { fixture } from './fixtures.js';

const MINIMAL = fixture('minimal');

describe('the session, and what it refuses to do twice', () => {
  it('shares one load between concurrent callers', async () => {
    const session = AxiomapSession.open(MINIMAL);
    expect(session.root).toBe(MINIMAL);
    expect(session.state).toBeNull();

    const [a, b, c] = await Promise.all([session.ready(), session.ready(), session.ready()]);

    // The same object, not an equal one: two graphs that are equal today are two
    // graphs that can disagree after the next rebuild.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(session.state).toBe(a);
    expect(a.graph.order).toBeGreaterThan(0);
  });

  it('answers a second ready() from state, without rebuilding', async () => {
    const session = AxiomapSession.open(MINIMAL);
    const first = await session.ready();

    let built = false;
    const second = await session.ready({
      onBuildStart: () => {
        built = true;
      },
    });

    expect(second).toBe(first);
    expect(built).toBe(false);
  });

  it('gives the same graph twice — the same nodes, the same edges', async () => {
    const one = await AxiomapSession.open(MINIMAL).ready();
    const two = await AxiomapSession.open(MINIMAL).ready();

    expect(two.graph.nodes().sort()).toEqual(one.graph.nodes().sort());
    expect(two.graph.size).toBe(one.graph.size);
    // The artifact a host would write, byte for byte. Two sessions over one
    // unchanged project that disagree is the failure the artifact-freshness
    // policy exists to prevent, and this is the assertion that it holds when
    // nothing changed either.
    expect(JSON.stringify(two.file)).toBe(JSON.stringify(one.file));
  });

  it('keeps the old graph answerable while a reload runs', async () => {
    const session = AxiomapSession.open(MINIMAL);
    const first = await session.ready();

    const pending = session.reload();
    // Not null, and not a half-built graph: the state is the previous one until
    // the new one is finished.
    expect(session.state).toBe(first);

    const reloaded = await pending;
    expect(session.state).toBe(reloaded);
    expect(reloaded.graph.nodes().sort()).toEqual(first.graph.nodes().sort());
  });

  it('moves the audit state and nothing else when the audit files change', async () => {
    const session = AxiomapSession.open(MINIMAL);
    const before = await session.ready();

    const after = session.refreshAuditState();
    expect(after).not.toBeNull();
    // Same graph object — re-reading `review.json` must never cost a parse.
    expect(after?.graph).toBe(before.graph);
    expect(after?.file).toBe(before.file);
    expect(after?.origin).toBe(before.origin);
  });

  it('has no audit state to refresh before the graph is loaded', () => {
    expect(AxiomapSession.open(MINIMAL).refreshAuditState()).toBeNull();
  });

  it('resolves §13’s render cap the way every other host does', () => {
    expect(AxiomapSession.open(MINIMAL).renderCap).toBe(1500);
  });
});
