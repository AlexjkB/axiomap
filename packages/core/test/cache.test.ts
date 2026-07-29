import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ParseCache, PARSE_SCHEMA_VERSION } from '../src/parse/cache.js';
import { createParser } from '../src/parse/index.js';
import { parseFiles } from '../src/parse/workers.js';
import { fixture } from './fixtures.js';

const SOURCE = 'pragma solidity ^0.8.20;\ncontract A { function f() external {} }\n';

describe('ParseCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'axiomap-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a parse result', async () => {
    const cache = await ParseCache.open(dir, 'antlr');
    const result = createParser('antlr').parse('A.sol', SOURCE);

    expect(cache.get('A.sol', SOURCE)).toBeNull();
    cache.set('A.sol', SOURCE, result);
    expect(cache.get('A.sol', SOURCE)).toEqual(result);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  it('misses when the content changes', async () => {
    const cache = await ParseCache.open(dir, 'antlr');
    cache.set('A.sol', SOURCE, createParser('antlr').parse('A.sol', SOURCE));

    expect(cache.get('A.sol', `${SOURCE}// touched\n`)).toBeNull();
  });

  it('does not share entries between parsers', async () => {
    const antlr = await ParseCache.open(dir, 'antlr');
    const treesitter = await ParseCache.open(dir, 'treesitter');

    antlr.set('A.sol', SOURCE, createParser('antlr').parse('A.sol', SOURCE));
    expect(treesitter.get('A.sol', SOURCE)).toBeNull();
  });

  it('does not share entries between paths', async () => {
    // The key carries the path so a hit never re-stamps SourceRefs onto the
    // wrong file — `pathological/` has two byte-similar `Duplicate.sol`s.
    const cache = await ParseCache.open(dir, 'antlr');
    cache.set('a/A.sol', SOURCE, createParser('antlr').parse('a/A.sol', SOURCE));

    expect(cache.get('b/A.sol', SOURCE)).toBeNull();
  });

  it('includes the schema version in the key', async () => {
    const cache = await ParseCache.open(dir, 'antlr');
    expect(PARSE_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(cache.key('A.sol', SOURCE)).not.toBe(cache.key('A.sol', `${SOURCE} `));
  });
});

describe('parseFiles', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'axiomap-pool-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('parses every file and reports cache misses then hits', async () => {
    const root = fixture('minimal');
    const files = [
      'src/Base.sol',
      'src/IVault.sol',
      'src/Token.sol',
      'src/Types.sol',
      'src/Vault.sol',
    ];

    const cold = await parseFiles(files, { root, parserId: 'antlr', cacheDir });
    expect([...cold.results.keys()].sort()).toEqual(files);
    expect(cold.stats.cacheMisses).toBe(5);
    expect(cold.stats.cacheHits).toBe(0);

    const warm = await parseFiles(files, { root, parserId: 'antlr', cacheDir });
    expect(warm.stats.cacheHits).toBe(5);
    expect(warm.results.get('src/Vault.sol')).toEqual(cold.results.get('src/Vault.sol'));
    expect(existsSync(cacheDir)).toBe(true);
  });

  it('turns an unreadable file into a diagnostic, not a crash', async () => {
    const run = await parseFiles(['src/DoesNotExist.sol'], {
      root: fixture('minimal'),
      parserId: 'antlr',
      cacheDir: null,
    });

    const result = run.results.get('src/DoesNotExist.sol');
    expect(result?.unit.contracts).toEqual([]);
    expect(result?.diagnostics[0]?.message).toContain('Cannot read');
  });
});
