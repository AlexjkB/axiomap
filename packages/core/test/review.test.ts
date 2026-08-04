/**
 * Review state and review invalidation (§8).
 *
 * §8 calls invalidation the flagship feature, so the tests that matter here are
 * the two directions it can be wrong in: a review that survives a change it
 * should not, and a review thrown away for a change that was not one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  classifyChanges,
  matchNodes,
  migrateReview,
  parseReview,
  readReview,
  ReviewSchemaError,
  reviewPath,
  serializeReview,
  setReviewStatus,
  stalenessOf,
  writeReview,
  type ReviewState,
} from '../src/index.js';
import { buildTempProject, cleanUpTempProjects } from './temp-project.js';

afterAll(cleanUpTempProjects);

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vault {
    uint256 public total;

    function deposit(uint256 amount) external {
        total += amount;
    }

    function helper(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b + 1;
    }
}
`;

const DEPOSIT = 'src/Vault.sol:Vault.deposit(uint256)';
const HELPER = 'src/Vault.sol:Vault.helper(uint256,uint256)';

function reviewed(bodyHash: string): ReviewState[string] {
  return { status: 'reviewed', bodyHash, reviewer: 'alice', note: 'checked', at: '2026-08-04T10:00:00Z' };
}

describe('review.json (§8)', () => {
  it('round-trips through the §8 shape, sorted and deterministic', () => {
    const state = setReviewStatus(setReviewStatus({}, HELPER, reviewed('b')), DEPOSIT, reviewed('a'));
    const text = serializeReview(state);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([DEPOSIT, HELPER]);
    expect(serializeReview(parseReview(JSON.parse(text)))).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('refuses a file that is not review state, and says what it wanted', () => {
    expect(() => parseReview({ [DEPOSIT]: { status: 'nope', bodyHash: 'a', at: 'x' } }, 'r.json')).toThrow(
      ReviewSchemaError,
    );
    expect(() => parseReview({ [DEPOSIT]: { status: 'reviewed' } })).toThrow(/bodyHash|Expected/);
  });

  it('treats an absent file as an empty review, not an error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-review-'));
    expect(readReview(reviewPath(root))).toEqual({});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes to .axiomap/review.json and reads it back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-review-'));
    const file = reviewPath(root);
    writeReview(file, { [DEPOSIT]: reviewed('a3f2') });
    expect(file.endsWith(path.join('.axiomap', 'review.json'))).toBe(true);
    expect(readReview(file)).toEqual({ [DEPOSIT]: reviewed('a3f2') });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('review invalidation (§8)', () => {
  it('is current while the body hash matches and stale the moment it does not', async () => {
    const before = await buildTempProject({ 'src/Vault.sol': SOURCE });
    const hash = before.graph.getNodeAttributes(DEPOSIT);
    const state: ReviewState = {
      [DEPOSIT]: reviewed(hash.kind === 'Function' ? hash.bodyHash : ''),
    };
    expect(stalenessOf(state, before.graph)[0]?.staleness).toBe('current');

    const after = await buildTempProject({
      'src/Vault.sol': SOURCE.replace('total += amount;', 'total += amount * 2;'),
    });
    const report = stalenessOf(state, after.graph)[0];
    expect(report?.staleness).toBe('stale');
    expect(report?.currentBodyHash).not.toBe(state[DEPOSIT]?.bodyHash);
  });

  it('is not invalidated by a comment', async () => {
    const before = await buildTempProject({ 'src/Vault.sol': SOURCE });
    const node = before.graph.getNodeAttributes(DEPOSIT);
    const state: ReviewState = { [DEPOSIT]: reviewed(node.kind === 'Function' ? node.bodyHash : '') };

    const after = await buildTempProject({
      'src/Vault.sol': SOURCE.replace('total += amount;', '// still fine\n        total += amount;'),
    });
    expect(stalenessOf(state, after.graph)[0]?.staleness).toBe('current');
  });

  it('reports a review whose node is gone as orphaned rather than current', async () => {
    const graph = (await buildTempProject({ 'src/Vault.sol': SOURCE })).graph;
    const state: ReviewState = { 'src/Gone.sol:Gone.f()': reviewed('a') };
    expect(stalenessOf(state, graph)[0]?.staleness).toBe('orphaned');
  });

  it('carries a review across a rename, and does not mark it stale', async () => {
    const before = await buildTempProject({ 'src/Vault.sol': SOURCE });
    const after = await buildTempProject({
      'src/Vault.sol': SOURCE.replace('function helper(', 'function combine('),
    });
    const node = before.graph.getNodeAttributes(HELPER);
    const state: ReviewState = { [HELPER]: reviewed(node.kind === 'Function' ? node.bodyHash : '') };

    const matching = matchNodes(before.graph, after.graph);
    const migrated = migrateReview(state, matching);
    const renamedId = 'src/Vault.sol:Vault.combine(uint256,uint256)';

    expect(migrated.remapped).toEqual([{ from: HELPER, to: renamedId, confidence: 0.95 }]);
    expect(migrated.dropped).toEqual([]);
    expect(stalenessOf(migrated.state, after.graph)[0]?.staleness).toBe('current');
  });

  it('carries a review across a move and still marks it stale when the body changed', async () => {
    const before = await buildTempProject({ 'src/Vault.sol': SOURCE });
    const after = await buildTempProject({
      'src/Vault.sol': SOURCE.replace('function helper(', 'function helper2(').replace(
        'return a + b + 1;',
        'return a + b + 2;',
      ),
    });
    const node = before.graph.getNodeAttributes(HELPER);
    const state: ReviewState = { [HELPER]: reviewed(node.kind === 'Function' ? node.bodyHash : '') };

    const diff = classifyChanges(before.graph, after.graph);
    const migrated = migrateReview(state, diff.matching);
    expect(migrated.remapped[0]?.to).toBe('src/Vault.sol:Vault.helper2(uint256,uint256)');
    // Remapped *and* stale: the right function is on the re-review list, and it
    // is on it for the right reason.
    expect(stalenessOf(migrated.state, after.graph)[0]?.staleness).toBe('stale');
  });

  it('keeps an unmatched entry under its old id rather than discarding it', async () => {
    const before = await buildTempProject({ 'src/Vault.sol': SOURCE });
    const after = await buildTempProject({
      'src/Vault.sol': SOURCE.replace(/ {4}function helper[\s\S]*?\n {4}}\n/, ''),
    });
    const node = before.graph.getNodeAttributes(HELPER);
    const state: ReviewState = { [HELPER]: reviewed(node.kind === 'Function' ? node.bodyHash : '') };

    const migrated = migrateReview(state, matchNodes(before.graph, after.graph));
    expect(migrated.dropped).toEqual([HELPER]);
    expect(migrated.state[HELPER]).toBeDefined();
    expect(stalenessOf(migrated.state, after.graph)[0]?.staleness).toBe('orphaned');
  });
});
