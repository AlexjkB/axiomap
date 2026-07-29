import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectProject, listSolidityFiles } from '../src/project/detect.js';
import { readFoundryConfig } from '../src/project/foundry.js';
import { readHardhatConfig } from '../src/project/hardhat.js';
import { describeUnresolvedImport, ImportResolver } from '../src/project/imports.js';
import { applyRemappings, parseRemappings, sortRemappings } from '../src/project/remappings.js';
import { fixture } from './fixtures.js';

describe('remappings', () => {
  it('parses plain and context-scoped forms', () => {
    const parsed = parseRemappings(
      ['@oz/=lib/openzeppelin/', 'src/Vault.sol:@oz/=lib/other/', '', '# a comment'].join('\n'),
      'remappings.txt',
    );

    expect(parsed).toEqual([
      { context: null, prefix: '@oz/', target: 'lib/openzeppelin/', source: 'remappings.txt' },
      {
        context: 'src/Vault.sol',
        prefix: '@oz/',
        target: 'lib/other/',
        source: 'remappings.txt',
      },
    ]);
  });

  it('prefers the longest prefix, then the scoped one', () => {
    const remappings = sortRemappings(
      parseRemappings(
        ['@oz/=lib/short/', '@oz/token/=lib/long/', 'src/:@oz/=lib/scoped/'].join('\n'),
        'test',
      ),
    );

    // Longest prefix first regardless of declaration order.
    expect(remappings[0]?.prefix).toBe('@oz/token/');
    // Among equal prefixes the context-scoped one wins.
    expect(remappings[1]?.context).toBe('src/');

    expect(applyRemappings('@oz/token/ERC20.sol', 'lib/x.sol', remappings)?.path).toBe(
      'lib/long/ERC20.sol',
    );
    expect(applyRemappings('@oz/Ownable.sol', 'src/Vault.sol', remappings)?.path).toBe(
      'lib/scoped/Ownable.sol',
    );
    // A file outside the context falls through to the unscoped remapping.
    expect(applyRemappings('@oz/Ownable.sol', 'test/X.sol', remappings)?.path).toBe(
      'lib/short/Ownable.sol',
    );
  });
});

describe('foundry.toml', () => {
  it('reads paths and inline remappings from the defi fixture', () => {
    const config = readFoundryConfig(fixture('defi'));

    expect(config).not.toBeNull();
    expect(config?.sources).toEqual(['src']);
    expect(config?.out).toBe('out');
    expect(config?.libs).toEqual(['lib']);
    expect(config?.remappings).toContainEqual({
      context: null,
      prefix: '@interfaces/',
      target: 'src/interfaces/',
      source: 'foundry.toml',
    });
  });

  it('applies Foundry defaults when the profile omits them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axiomap-foundry-'));
    try {
      await writeFile(join(root, 'foundry.toml'), '[profile.default]\nsolc = "0.8.28"\n');
      const config = readFoundryConfig(root);
      expect(config).toMatchObject({ sources: ['src'], out: 'out', libs: ['lib'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives the implicit lib remappings Foundry adds for free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axiomap-foundry-'));
    try {
      await writeFile(join(root, 'foundry.toml'), '[profile.default]\n');
      await mkdir(join(root, 'lib/forge-std/src'), { recursive: true });
      await mkdir(join(root, 'lib/solmate'), { recursive: true });

      const config = readFoundryConfig(root);
      expect(config?.remappings).toContainEqual({
        context: null,
        prefix: 'forge-std/',
        target: 'lib/forge-std/src/',
        source: 'foundry:implicit-lib',
      });
      // No src/ directory, so the package root is the target.
      expect(config?.remappings).toContainEqual({
        context: null,
        prefix: 'solmate/',
        target: 'lib/solmate/',
        source: 'foundry:implicit-lib',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles a multi-line remappings array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axiomap-foundry-'));
    try {
      await writeFile(
        join(root, 'foundry.toml'),
        ['[profile.default]', 'remappings = [', '  "@a/=lib/a/",', '  "@b/=lib/b/",', ']'].join(
          '\n',
        ),
      );
      const config = readFoundryConfig(root);
      expect(config?.remappings.map((r) => r.prefix)).toEqual(['@a/', '@b/']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('hardhat.config', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'axiomap-hardhat-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads paths.sources statically', async () => {
    await writeFile(
      join(root, 'hardhat.config.ts'),
      [
        'export default {',
        '  solidity: "0.8.24",',
        '  paths: { sources: "./contracts/core", artifacts: "./build" },',
        '};',
      ].join('\n'),
    );

    expect(readHardhatConfig(root)).toMatchObject({
      configPath: 'hardhat.config.ts',
      sources: ['./contracts/core'],
      artifacts: './build',
      usedDefaults: false,
    });
  });

  it('never executes the config', async () => {
    // If this file were ever `require`d or `import`ed, the process would exit.
    await writeFile(
      join(root, 'hardhat.config.js'),
      [
        'process.exit(99);',
        'module.exports = { paths: { sources: "src" } };',
      ].join('\n'),
    );

    expect(readHardhatConfig(root)).toMatchObject({ sources: ['src'] });
  });

  it('falls back to defaults when paths are computed at runtime', async () => {
    await writeFile(
      join(root, 'hardhat.config.js'),
      'module.exports = { paths: { sources: process.env.SRC } };',
    );

    expect(readHardhatConfig(root)).toMatchObject({
      sources: ['contracts'],
      usedDefaults: true,
    });
  });
});

describe('detectProject', () => {
  it('identifies the fixtures as foundry projects', () => {
    for (const name of ['minimal', 'defi', 'inheritance', 'pathological']) {
      expect(detectProject(fixture(name)).kind).toBe('foundry');
    }
  });

  it('treats a directory with no config as bare, with a diagnostic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axiomap-bare-'));
    try {
      await writeFile(join(root, 'A.sol'), 'contract A {}\n');
      const project = detectProject(root);

      expect(project.kind).toBe('bare');
      expect(project.diagnostics.some((d) => d.message.includes('bare Solidity tree'))).toBe(true);
      expect(listSolidityFiles(project)).toEqual(['A.sol']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips build output and dependency directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axiomap-skip-'));
    try {
      await writeFile(join(root, 'foundry.toml'), '[profile.default]\nout = "artifacts-out"\n');
      for (const dir of ['src', 'test', 'node_modules', 'out', 'artifacts-out', 'lib/dep']) {
        await mkdir(join(root, dir), { recursive: true });
        await writeFile(join(root, dir, 'A.sol'), 'contract A {}\n');
      }

      // lib/ is kept: base contracts live there and the graph needs them.
      // test/ is kept: "which of these are scaffolding" is a question the tool
      // exists to answer, and it cannot if test sources are never read.
      expect(listSolidityFiles(detectProject(root))).toEqual([
        'lib/dep/A.sol',
        'src/A.sol',
        'test/A.sol',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ImportResolver', () => {
  const files = [
    'src/Vault.sol',
    'src/token/ERC20.sol',
    'lib/oz/contracts/access/Ownable.sol',
    'node_modules/@scope/pkg/Thing.sol',
  ];
  const remappings = sortRemappings(
    parseRemappings('@oz/=lib/oz/contracts/', 'remappings.txt'),
  );
  const resolver = new ImportResolver({ files, remappings, sources: ['src'] });

  it('resolves relative imports against the importing file', () => {
    expect(resolver.resolve('src/Vault.sol', './token/ERC20.sol')).toMatchObject({
      resolved: 'src/token/ERC20.sol',
      via: 'relative',
    });
    expect(resolver.resolve('src/token/ERC20.sol', '../Vault.sol')).toMatchObject({
      resolved: 'src/Vault.sol',
      via: 'relative',
    });
  });

  it('resolves through remappings, node_modules and source roots', () => {
    expect(resolver.resolve('src/Vault.sol', '@oz/access/Ownable.sol')).toMatchObject({
      resolved: 'lib/oz/contracts/access/Ownable.sol',
      via: 'remapping',
    });
    expect(resolver.resolve('src/Vault.sol', '@scope/pkg/Thing.sol')).toMatchObject({
      resolved: 'node_modules/@scope/pkg/Thing.sol',
      via: 'node_modules',
    });
    expect(resolver.resolve('src/Vault.sol', 'token/ERC20.sol')).toMatchObject({
      resolved: 'src/token/ERC20.sol',
      via: 'source-root',
    });
  });

  it('returns an unresolved result rather than throwing', () => {
    const result = resolver.resolve('src/Vault.sol', '@missing/Thing.sol');

    expect(result.resolved).toBeNull();
    expect(result.via).toBeNull();
    expect(result.attempts.length).toBeGreaterThan(0);
  });

  it('names what it checked in the failure message (§6)', () => {
    const result = resolver.resolve('src/Vault.sol', '@missing/Thing.sol');
    const message = describeUnresolvedImport(result, ['foundry.toml', 'remappings.txt']);

    expect(message).toContain('@missing/Thing.sol');
    expect(message).toContain('src/Vault.sol');
    expect(message).toContain('foundry.toml');
    expect(message).toContain('remappings.txt');
    expect(message).toContain('node_modules');
  });
});
