/**
 * §13's `axiomap.config.json`, and the glob subset it needs.
 *
 * Nothing read this file before Phase 6, so these are the first tests of it.
 * The two properties that matter most are at the bottom: a project with no
 * config behaves exactly as it did before the loader existed (the goldens
 * depend on it), and a typo produces a warning rather than a refusal.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ConfigError, globToRegExp, loadConfig, parseConfig, pathFilter } from '../src/index.js';
import { buildTempProject, cleanUpTempProjects } from './temp-project.js';

const temporary: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-config-'));
  temporary.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  cleanUpTempProjects();
});

describe('globs', () => {
  const matches = (pattern: string, file: string): boolean => globToRegExp(pattern).test(file);

  it('matches §13\'s own examples', () => {
    expect(matches('src/**/*.sol', 'src/Vault.sol')).toBe(true);
    expect(matches('src/**/*.sol', 'src/token/ERC20.sol')).toBe(true);
    expect(matches('src/**/*.sol', 'test/Vault.t.sol')).toBe(false);
    expect(matches('test/**', 'test/Vault.t.sol')).toBe(true);
    expect(matches('lib/forge-std/**', 'lib/forge-std/src/Test.sol')).toBe(true);
    expect(matches('lib/forge-std/**', 'lib/openzeppelin/src/Test.sol')).toBe(false);
  });

  it('`*` stops at a separator and `**` does not', () => {
    expect(matches('src/*.sol', 'src/Vault.sol')).toBe(true);
    expect(matches('src/*.sol', 'src/token/ERC20.sol')).toBe(false);
    expect(matches('src/**', 'src/a/b/c/D.sol')).toBe(true);
  });

  it('a trailing `/**` matches the directory itself', () => {
    // Otherwise `exclude: ["test/**"]` leaves a stubborn `test` entry behind
    // and the surprise surfaces as a directory that refuses to be excluded.
    expect(matches('test/**', 'test')).toBe(true);
  });

  it('`a/**/b` matches `a/b`', () => {
    expect(matches('a/**/b', 'a/b')).toBe(true);
    expect(matches('a/**/b', 'a/x/y/b')).toBe(true);
  });

  it('supports alternation and `?`', () => {
    expect(matches('src/{Vault,Pair}.sol', 'src/Pair.sol')).toBe(true);
    expect(matches('src/{Vault,Pair}.sol', 'src/Router.sol')).toBe(false);
    expect(matches('src/V?ult.sol', 'src/Vault.sol')).toBe(true);
  });

  it('treats a dot as a literal, not as "any character"', () => {
    expect(matches('src/Vault.sol', 'src/VaultXsol')).toBe(false);
  });

  it('exclude beats include', () => {
    const keep = pathFilter(['src/**'], ['src/mocks/**']);
    expect(keep('src/Vault.sol')).toBe(true);
    expect(keep('src/mocks/MockToken.sol')).toBe(false);
    expect(keep('test/Vault.t.sol')).toBe(false);
  });

  it('no include means everything', () => {
    const keep = pathFilter(undefined, ['test/**']);
    expect(keep('src/Vault.sol')).toBe(true);
    expect(keep('anywhere/at/all.sol')).toBe(true);
    expect(keep('test/Vault.t.sol')).toBe(false);
  });
});

describe('axiomap.config.json', () => {
  it('reads every field §13 documents', () => {
    const { config } = parseConfig(
      JSON.stringify({
        include: ['src/**/*.sol'],
        exclude: ['test/**'],
        entrypoints: ['src/Vault.sol:Vault'],
        accessControlModifiers: ['auth'],
        reentrancyGuards: ['lock'],
        trustBoundaries: { external: ['lib/**'] },
        renderCap: 1500,
        layout: 'elk-layered',
      }),
      'test',
    );
    expect(config.include).toEqual(['src/**/*.sol']);
    expect(config.reentrancyGuards).toEqual(['lock']);
    expect(config.trustBoundaries?.external).toEqual(['lib/**']);
    // Read and carried but not consumed until Phase 7; validating them now
    // means a user's config does not start failing the day the webview lands.
    expect(config.renderCap).toBe(1500);
    expect(config.layout).toBe('elk-layered');
  });

  it('warns about an unknown key instead of refusing the file', () => {
    const { config, warnings } = parseConfig('{"accessControlModifers": ["auth"]}', 'cfg');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('accessControlModifers');
    // The point of the warning: the guard list is *not* silently applied.
    expect(config.accessControlModifiers).toBeUndefined();
  });

  it('refuses a field of the wrong type, naming it', () => {
    expect(() => parseConfig('{"renderCap": "lots"}', 'cfg')).toThrow(ConfigError);
    expect(() => parseConfig('{"include": "src"}', 'cfg')).toThrow(/include/);
  });

  it('refuses malformed JSON and a non-object', () => {
    expect(() => parseConfig('{', 'cfg')).toThrow(/not valid JSON/);
    expect(() => parseConfig('[]', 'cfg')).toThrow(/JSON object/);
  });

  it('an absent file at the default location is not an error', () => {
    const loaded = loadConfig(tempDir());
    expect(loaded.file).toBeNull();
    expect(loaded.config).toEqual({});
    expect(loaded.warnings).toEqual([]);
  });

  it('an explicitly named file that is absent *is* an error', () => {
    // The user asked for it by name; falling back to defaults would silently
    // audit the protocol with the wrong settings.
    expect(() => loadConfig(tempDir(), '/nonexistent/axiomap.config.json')).toThrow(ConfigError);
  });

  it('loads the file next to the project', () => {
    const root = tempDir();
    fs.writeFileSync(
      path.join(root, 'axiomap.config.json'),
      JSON.stringify({ reentrancyGuards: ['lock'] }),
    );
    const loaded = loadConfig(root);
    expect(loaded.file).toBe(path.join(root, 'axiomap.config.json'));
    expect(loaded.config.reentrancyGuards).toEqual(['lock']);
  });
});

describe('the artifact records the settings that produced it', () => {
  /**
   * Without this, `.axiomap/graph.json` built with `exclude` or `--no-enrich`
   * is indistinguishable from one built without, and `axiomap query` answers
   * confidently from a graph that was built to answer a different question.
   * Phase 7 reads this artifact too, which is why the schema bump happened
   * before it existed rather than after.
   */
  it('is absent entirely for a default build, so no golden moves', async () => {
    const built = await buildTempProject({
      'src/A.sol': 'pragma solidity ^0.8.20;\ncontract A { function f() public {} }\n',
    });
    expect(built.file.generator.settings).toBeUndefined();
  });

  it('records exclude, the guard lists, and a deliberate --no-enrich', async () => {
    const built = await buildTempProject(
      { 'src/A.sol': 'pragma solidity ^0.8.20;\ncontract A { function f() public {} }\n' },
      {
        exclude: ['test/**'],
        analysis: { accessControlModifiers: ['gated'], reentrancyGuards: ['lock'] },
        trustBoundaries: { external: ['lib/**'] },
        enrich: false,
      },
    );
    expect(built.file.generator.settings).toEqual({
      exclude: ['test/**'],
      accessControlModifiers: ['gated'],
      reentrancyGuards: ['lock'],
      trustBoundaries: ['lib/**'],
      enrich: false,
    });
  });

  it('survives the serialize/parse round trip', async () => {
    const built = await buildTempProject(
      { 'src/A.sol': 'pragma solidity ^0.8.20;\ncontract A { function f() public {} }\n' },
      { analysis: { reentrancyGuards: ['lock'] } },
    );
    const { parseGraph, serializeGraph } = await import('../src/index.js');
    expect(parseGraph(serializeGraph(built.file)).generator.settings).toEqual({
      reentrancyGuards: ['lock'],
    });
  });
});
