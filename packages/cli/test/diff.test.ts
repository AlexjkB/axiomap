/**
 * §7's Phase 5 exit criterion, as a test:
 *
 * > `axiomap diff` between two commits of the `defi/` fixture correctly
 * > identifies a hand-authored set of changes including one rename and one
 * > moved function.
 *
 * The two commits are the git tags `defi-v1` and `defi-v2` (§14). Every
 * expectation below was written from `git diff defi-v1 defi-v2` — the changeset
 * was authored first and by hand, and the engine was built against it
 * afterwards. `docs/fixtures/defi-diff.md` is the changeset in prose.
 *
 * The tags are the fixture. A checkout without them is a checkout without half
 * of `defi/`, so a missing tag fails loudly here rather than skipping — a test
 * that quietly stops running is worse than no test (§6).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { runDiff, type DiffCommandResult } from '../src/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGET = path.join(REPO, 'fixtures/defi');

const RENAMED_FROM = 'src/Router.sol:Router.quote(uint256,uint256,uint256)';
const RENAMED_TO = 'src/Router.sol:Router.quoteAmount(uint256,uint256,uint256)';
const MOVED_FROM = 'src/libraries/AmmMath.sol:AmmMath.sortTokens(address,address)';
const MOVED_TO = 'src/libraries/TokenOrder.sol:TokenOrder.sortTokens(address,address)';

let result: DiffCommandResult;

beforeAll(async () => {
  for (const tag of ['defi-v1', 'defi-v2']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      throw new Error(
        `The git tag "${tag}" is missing. It is half of the §14 diff fixture, not optional — ` +
          'fetch tags (`git fetch --tags`) and run again.',
      );
    }
  }
  result = await runDiff('defi-v1', 'defi-v2', { target: TARGET });
}, 120_000);

function change(id: string): { status: string; changes: string[]; previous: string | null; tier: string | null } {
  const found = result.diff.nodes.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no node change for ${id}`);
  return {
    status: found.status,
    changes: found.changes,
    previous: found.match === null ? null : found.match.before,
    tier: found.match === null ? null : found.match.tier,
  };
}

function findings(kind: string): string[] {
  return result.diff.findings.filter((f) => f.kind === kind).map((f) => f.node);
}

describe('axiomap diff defi-v1 defi-v2', () => {
  it('finds the one renamed function, by body hash, with the body untouched', () => {
    const renamed = change(RENAMED_TO);
    expect(renamed.status).toBe('renamed');
    expect(renamed.previous).toBe(RENAMED_FROM);
    expect(renamed.tier).toBe('body');
    // Only the name and the hash that carries it: `quoteAmount` is `quote`.
    expect(renamed.changes).toEqual(['interfaceHash', 'name']);
    expect(result.diff.nodes.some((node) => node.id === RENAMED_FROM)).toBe(false);
  });

  it('finds the one moved function, across a file and a library', () => {
    const moved = change(MOVED_TO);
    expect(moved.status).toBe('moved');
    expect(moved.previous).toBe(MOVED_FROM);
    expect(moved.tier).toBe('body');
    expect(moved.changes).toEqual(['file', 'scope']);
  });

  it('reports exactly one rename and one move', () => {
    expect(result.diff.nodeSummary.renamed + result.diff.nodeSummary.moved).toBe(3);
    const byStatus = (status: string): string[] =>
      result.diff.nodes.filter((node) => node.status === status).map((node) => node.id);
    expect(byStatus('moved')).toEqual([MOVED_TO]);
    // Two renames: the body-hash one above, and `getAmountOut` → `amountOutFor`
    // whose body also changed and so is only reachable through the fuzzy tier.
    expect(byStatus('renamed').sort()).toEqual(
      [RENAMED_TO, 'src/Router.sol:Router.amountOutFor(address,address,uint256)'].sort(),
    );
  });

  it('finds the fuzzy rename, and reports a confidence rather than a certainty', () => {
    const fuzzy = change('src/Router.sol:Router.amountOutFor(address,address,uint256)');
    expect(fuzzy.status).toBe('renamed');
    expect(fuzzy.tier).toBe('fuzzy');
    expect(fuzzy.previous).toBe('src/Router.sol:Router.getAmountOut(address,address,uint256)');
    const match = result.diff.nodes.find(
      (node) => node.id === 'src/Router.sol:Router.amountOutFor(address,address,uint256)',
    )?.match;
    expect(match?.confidence).toBeLessThan(1);
    expect(match?.evidence?.signature).toBe(1);
  });

  it('matches a changed signature by container and name', () => {
    const updated = change('src/Pair.sol:Pair._update()');
    expect(updated.tier).toBe('signature');
    expect(updated.previous).toBe('src/Pair.sol:Pair._update(uint256,uint256)');
    expect(updated.status).toBe('modified');
  });

  it('lists exactly the hand-authored additions and removals', () => {
    const byStatus = (status: string): string[] =>
      result.diff.nodes
        .filter((node) => node.status === status)
        .map((node) => node.id)
        .sort();
    expect(byStatus('added')).toEqual([
      'src/Factory.sol:Factory!FeeTransferFailed()',
      'src/Factory.sol:Factory!InsufficientFee()',
      'src/Factory.sol:Factory.collectFees(address,uint256)',
      'src/Factory.sol:Factory.creationFee',
      'src/Factory.sol:Factory.setCreationFee(uint256)',
      'src/Router.sol:Router.sweep(address,address,uint256)',
      'src/libraries/TokenOrder.sol',
      'src/libraries/TokenOrder.sol:TokenOrder',
    ]);
    // `AmmMath.min` was inlined into `Pair.mint`. `sortTokens` left the same
    // library in the same commit and is *not* here, because it moved.
    expect(byStatus('removed')).toEqual(['src/libraries/AmmMath.sol:AmmMath.min(uint256,uint256)']);
  });

  it('lists exactly the hand-authored modifications', () => {
    const modified = result.diff.nodes
      .filter((node) => node.status === 'modified')
      .map((node) => node.id)
      .sort();
    expect(modified).toEqual([
      'src/Factory.sol:Factory.createPair(address,address)',
      'src/Factory.sol:Factory.setFeeSetter(address)',
      'src/Pair.sol:Pair._update()',
      'src/Pair.sol:Pair.burn(address)',
      'src/Pair.sol:Pair.mint(address)',
      'src/Pair.sol:Pair.swap(uint256,uint256,address)',
      'src/Router.sol:Router.swapExactTokensForTokens(address,address,uint256,uint256,address,uint256)',
      'src/interfaces/IAmm.sol:IFactory.createPair(address,address)',
    ]);
  });

  it('leaves the rest of the protocol alone', () => {
    // Seventy-eight nodes untouched. A matcher that drifted would show up here
    // first, as a node reported changed for no reason in the source diff.
    expect(result.diff.nodeSummary.unchanged).toBe(78);
    expect(result.diff.nodes).toHaveLength(98);
  });

  describe('the findings §8 calls the actual product', () => {
    it('finds the access-control regression on setFeeSetter', () => {
      expect(findings('access-control-weakened')).toEqual([
        'src/Factory.sol:Factory.setFeeSetter(address)',
      ]);
      const finding = result.diff.findings.find((f) => f.kind === 'access-control-weakened');
      expect(finding?.severity).toBe('high');
      expect(finding?.message).toContain('from low to none');
    });

    it('finds the shifted storage layout on Factory', () => {
      const finding = result.diff.findings.find((f) => f.kind === 'storage-layout-changed');
      expect(finding?.node).toBe('src/Factory.sol:Factory');
      expect(finding?.message).toContain('[feeSetter, pairs, allPairs] → [feeSetter, creationFee, pairs, allPairs]');
    });

    it('finds the three new external entrypoints, and which one is unguarded', () => {
      expect(findings('new-external-entrypoint').sort()).toEqual([
        'src/Factory.sol:Factory.collectFees(address,uint256)',
        'src/Factory.sol:Factory.setCreationFee(uint256)',
        'src/Router.sol:Router.sweep(address,address,uint256)',
      ]);
      const unguarded = result.diff.findings.filter(
        (f) => f.kind === 'new-external-entrypoint' && f.message.includes('no recognised access control'),
      );
      expect(unguarded.map((f) => f.node)).toEqual(['src/Router.sol:Router.sweep(address,address,uint256)']);
    });

    it('finds both sides of createPair becoming payable', () => {
      expect(findings('became-payable').sort()).toEqual([
        'src/Factory.sol:Factory.createPair(address,address)',
        'src/interfaces/IAmm.sol:IFactory.createPair(address,address)',
      ]);
    });

    it('finds the new low-level call that sends value', () => {
      const messages = result.diff.findings
        .filter((f) => f.kind === 'new-dangerous-op')
        .map((f) => f.message);
      expect(messages).toEqual([
        'New function Factory.collectFees uses hasLowLevelCall',
        'New function Factory.collectFees uses sendsValue',
      ]);
    });

    it('finds the external calls _update grew', () => {
      expect(findings('new-external-call')).toEqual(['src/Pair.sol:Pair._update()']);
    });

    it('finds IERC20Minimal.transfer becoming reachable, and calls it a consequence', () => {
      // Router.sweep is what made it reachable; `transfer` itself is an
      // interface declaration nobody touched. §10's Phase 4 fields are
      // transitive, and a finding on an unchanged node has to say so.
      const finding = result.diff.findings.find((f) => f.kind === 'became-externally-reachable');
      expect(finding?.node).toBe('src/interfaces/IAmm.sol:IERC20Minimal.transfer(address,uint256)');
      expect(finding?.evidence).toBe('consequence');
      expect(change(finding?.node ?? '').status).toBe('unchanged');
    });

    it('finds nothing else', () => {
      expect(result.diff.findings).toHaveLength(11);
    });
  });

  it('exits non-zero, so it works as a CI gate', () => {
    expect(result.exitCode).toBe(1);
  });

  it('prints the rename and the move in its default output', () => {
    expect(result.text).toContain(`${RENAMED_FROM} → ${RENAMED_TO}`);
    expect(result.text).toContain(`${MOVED_FROM} → ${MOVED_TO}`);
    expect(result.text).toContain('access-control-weakened');
  });
});

describe('axiomap diff, other shapes', () => {
  it('takes two directory paths as well as two revisions (§12)', async () => {
    const same = await runDiff(TARGET, TARGET, { target: TARGET });
    expect(same.exitCode).toBe(0);
    expect(same.diff.findings).toEqual([]);
    expect(same.text).toContain('findings  none');
  });

  it('emits a machine-readable summary for CI', async () => {
    const json = await runDiff('defi-v1', 'defi-v2', { target: TARGET, json: true });
    const parsed = JSON.parse(json.text) as {
      findings: { kind: string }[];
      changes: { id: string; previousId?: string; matchTier?: string }[];
    };
    expect(parsed.findings).toHaveLength(11);
    const moved = parsed.changes.find((c) => c.id === MOVED_TO);
    expect(moved?.previousId).toBe(MOVED_FROM);
    expect(moved?.matchTier).toBe('body');
  }, 120_000);

  it('says what is wrong when a revision does not exist', async () => {
    await expect(runDiff('defi-v1', 'no-such-rev', { target: TARGET })).rejects.toThrow(
      /no-such-rev/,
    );
  });
});
