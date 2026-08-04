/**
 * The semantic tier against artifacts written by hand.
 *
 * `enrich.test.ts` covers the real thing: a real `forge build --build-info` for
 * `defi/`, committed. What it cannot cover is a project with two solc versions
 * in it, a Hardhat layout, or the two shape changes §7 allows — none of which
 * exist in a fixture, and all of which are behaviour someone will break.
 *
 * So these build a tiny project and the artifact that goes with it. The ASTs
 * are hand-written, which is the point: they are a *specification* of what this
 * tier reads out of a solc AST, small enough to check by eye, and they fail
 * loudly if the reader starts depending on a field solc happens to emit rather
 * than one it promises.
 *
 * Two of them describe a binding solc itself would never produce, and say so
 * where they do. That is deliberate — every unresolved edge in every real
 * fixture is a genuinely unbindable low-level call, so a compiler *agreeing*
 * with one has no natural fixture, and the mechanism would otherwise go
 * untested until a user's project exercised it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProjectGraph, detectProject, discoverBuildInfo, type GraphEdge } from '../src/index.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-enrich-'));
  temporary.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

interface AstNode {
  nodeType: string;
  id?: number;
  src?: string;
  [key: string]: unknown;
}

/** `"start:length:sourceIndex"`, from where a substring actually is. */
function at(source: string, text: string, from = 0): string {
  const offset = Buffer.byteLength(source.slice(0, source.indexOf(text, from)), 'utf8');
  return `${offset}:${Buffer.byteLength(text, 'utf8')}:0`;
}

function writeBuildInfo(
  root: string,
  dir: string,
  name: string,
  info: {
    solcVersion: string;
    sources: Record<string, { content: string; nodes: AstNode[]; storage?: unknown }>;
  },
): void {
  const input: Record<string, unknown> = {};
  const output: Record<string, unknown> = {};
  const contracts: Record<string, unknown> = {};
  let id = 0;

  for (const [file, source] of Object.entries(info.sources)) {
    input[file] = { content: source.content };
    output[file] = { id: id++, ast: { nodeType: 'SourceUnit', nodes: source.nodes } };
    if (source.storage !== undefined) {
      contracts[file] = { C: { storageLayout: source.storage } };
    }
  }

  const target = path.join(root, dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      _format: 'hh-sol-build-info-1',
      solcVersion: info.solcVersion,
      input: { language: 'Solidity', sources: input },
      output: { sources: output, contracts },
    }),
  );
}

/**
 * The mode gate is pinned off. These projects are two or three functions long,
 * so one honest `unresolved` call is 100% of the call edges and §4's threshold
 * would put them in structural mode — which drops the very edges under test.
 * §16 already carries "a small-project floor for the mode threshold" for the
 * same reason; this is not that bug, it is a fixture too small to be evidence.
 */
const build = (root: string): ReturnType<typeof buildProjectGraph> =>
  buildProjectGraph(root, { cacheDir: null, workers: 1, callResolutionThreshold: 0 });

function edgesBetween(edges: readonly GraphEdge[], from: string, to: string): GraphEdge[] {
  return edges.filter((e) => e.from === from && e.to === to);
}

describe('semantic tier against hand-written artifacts', () => {
  it('handles two solc versions in one project', async () => {
    const older = [
      'pragma solidity 0.7.6;',
      'contract Old {',
      '    function ping() public {}',
      '    function callPing() public { ping(); }',
      '}',
      '',
    ].join('\n');
    const newer = [
      'pragma solidity 0.8.20;',
      'contract New {',
      '    function pong() public {}',
      '    function callPong() public { pong(); }',
      '}',
      '',
    ].join('\n');

    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/Old.sol': older,
      'src/New.sol': newer,
    });

    writeBuildInfo(root, 'out/build-info', 'old.json', {
      solcVersion: '0.7.6',
      sources: {
        'src/Old.sol': {
          content: older,
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 1,
              src: at(older, 'contract Old {'),
              name: 'Old',
              nodes: [
                {
                  nodeType: 'FunctionDefinition',
                  id: 2,
                  src: at(older, 'function ping() public {}'),
                  name: 'ping',
                },
                {
                  nodeType: 'FunctionDefinition',
                  id: 3,
                  src: at(older, 'function callPing() public { ping(); }'),
                  name: 'callPing',
                  body: {
                    nodeType: 'Block',
                    statements: [
                      {
                        nodeType: 'FunctionCall',
                        src: at(older, 'ping()', older.indexOf('callPing')),
                        expression: {
                          nodeType: 'Identifier',
                          src: at(older, 'ping()', older.indexOf('callPing')),
                          referencedDeclaration: 2,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    });

    writeBuildInfo(root, 'out/build-info', 'new.json', {
      solcVersion: '0.8.20',
      sources: {
        'src/New.sol': {
          content: newer,
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 11,
              src: at(newer, 'contract New {'),
              name: 'New',
              nodes: [
                {
                  nodeType: 'FunctionDefinition',
                  id: 12,
                  src: at(newer, 'function pong() public {}'),
                  name: 'pong',
                },
                {
                  nodeType: 'FunctionDefinition',
                  id: 13,
                  src: at(newer, 'function callPong() public { pong(); }'),
                  name: 'callPong',
                  body: {
                    nodeType: 'Block',
                    statements: [
                      {
                        nodeType: 'FunctionCall',
                        src: at(newer, 'pong()', newer.indexOf('callPong')),
                        expression: {
                          nodeType: 'Identifier',
                          src: at(newer, 'pong()', newer.indexOf('callPong')),
                          referencedDeclaration: 12,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    });

    const { file, semantic } = await build(root);

    expect(semantic?.covered).toBe(2);
    expect(file.generator.compilers).toEqual(['0.7.6', '0.8.20']);
    expect(file.diagnostics.some((d) => d.message.includes('2 solc versions'))).toBe(true);

    for (const [from, to] of [
      ['src/Old.sol:Old.callPing()', 'src/Old.sol:Old.ping()'],
      ['src/New.sol:New.callPong()', 'src/New.sol:New.pong()'],
    ]) {
      const [edge] = edgesBetween(file.edges, from!, to!);
      expect(edge?.resolution, `${from} -> ${to}`).toBe('semantic');
    }

    // §4: a 0.7 file is graphed and enriched, and still excluded from the
    // score — the version policy is about what counts as evidence, not about
    // what gets analysed.
    expect(file.score.excludedFiles).toBe(1);
  });

  it('finds Hardhat build-info under artifacts/', async () => {
    const source = [
      'pragma solidity ^0.8.20;',
      'contract C {',
      '    function inner() internal {}',
      '    function outer() external { inner(); }',
      '}',
      '',
    ].join('\n');

    const root = project({
      'hardhat.config.js': 'module.exports = { paths: { sources: "contracts" } };\n',
      'contracts/C.sol': source,
    });

    writeBuildInfo(root, 'artifacts/build-info', 'abc.json', {
      solcVersion: '0.8.24',
      sources: {
        'contracts/C.sol': {
          content: source,
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 1,
              src: at(source, 'contract C {'),
              name: 'C',
              nodes: [
                {
                  nodeType: 'FunctionDefinition',
                  id: 2,
                  src: at(source, 'function inner() internal {}'),
                  name: 'inner',
                },
                {
                  nodeType: 'FunctionDefinition',
                  id: 3,
                  src: at(source, 'function outer() external { inner(); }'),
                  name: 'outer',
                  functionSelector: '11223344',
                  body: {
                    nodeType: 'Block',
                    statements: [
                      {
                        nodeType: 'FunctionCall',
                        src: at(source, 'inner()', source.indexOf('outer')),
                        expression: {
                          nodeType: 'Identifier',
                          src: at(source, 'inner()', source.indexOf('outer')),
                          referencedDeclaration: 2,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
          storage: {
            storage: [{ astId: 2, contract: 'contracts/C.sol:C', label: 'x', offset: 0, slot: '7' }],
          },
        },
      },
    });

    const { file, semantic } = await build(root);
    expect(semantic?.covered).toBe(1);
    expect(file.mode).toBe('full');

    const [edge] = edgesBetween(file.edges, 'contracts/C.sol:C.outer()', 'contracts/C.sol:C.inner()');
    expect(edge?.resolution).toBe('semantic');

    const outer = file.nodes.find((n) => n.id === 'contracts/C.sol:C.outer()');
    expect(outer?.kind === 'Function' ? outer.selector : undefined).toBe('0x11223344');
  });

  it('retargets an unresolved edge and drops the placeholder it leaves behind', async () => {
    // `helper` is not in scope for `C`, so the resolver is right to give up and
    // point at `?not-found:helper`. The artifact below then claims the compiler
    // bound it to `Other.helper` — a binding solc would not produce for this
    // source, standing in for the ones it does produce that no fixture has:
    // §16's expression-receiver `using`-for calls and nested namespace members.
    const source = [
      'pragma solidity ^0.8.20;',
      'contract Other {',
      '    function helper() internal {}',
      '}',
      'contract C {',
      '    function run() external { helper(); }',
      '}',
      '',
    ].join('\n');

    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/C.sol': source,
    });

    const heuristic = await buildProjectGraph(root, {
      cacheDir: null,
      workers: 1,
      enrich: false,
      callResolutionThreshold: 0,
    });
    expect(heuristic.file.nodes.some((n) => n.id === '?not-found:helper')).toBe(true);

    writeBuildInfo(root, 'out/build-info', 'x.json', {
      solcVersion: '0.8.24',
      sources: {
        'src/C.sol': {
          content: source,
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 1,
              src: at(source, 'contract Other {'),
              name: 'Other',
              nodes: [
                {
                  nodeType: 'FunctionDefinition',
                  id: 2,
                  src: at(source, 'function helper() internal {}'),
                  name: 'helper',
                },
              ],
            },
            {
              nodeType: 'ContractDefinition',
              id: 3,
              src: at(source, 'contract C {'),
              name: 'C',
              nodes: [
                {
                  nodeType: 'FunctionDefinition',
                  id: 4,
                  src: at(source, 'function run() external { helper(); }'),
                  name: 'run',
                  body: {
                    nodeType: 'Block',
                    statements: [
                      {
                        nodeType: 'FunctionCall',
                        src: at(source, 'helper()', source.indexOf('run')),
                        expression: {
                          nodeType: 'Identifier',
                          src: at(source, 'helper()', source.indexOf('run')),
                          referencedDeclaration: 2,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    });

    const { file } = await build(root);

    const [edge] = edgesBetween(file.edges, 'src/C.sol:C.run()', 'src/C.sol:Other.helper()');
    expect(edge?.resolution).toBe('semantic');
    expect(edge?.reason).toBeUndefined();

    // §7's two legal shape changes, both of them: the unresolved edge found a
    // real target, and the synthetic node it used to point at is orphaned and
    // gone.
    expect(file.nodes.some((n) => n.kind === 'Unresolved')).toBe(false);
    expect(file.score.overall.unresolved).toBe(0);
  });

  it('prunes the overload candidates the compiler ruled out', async () => {
    const source = [
      'pragma solidity ^0.8.20;',
      'contract C {',
      '    function f(uint256 a) internal {}',
      '    function f(address a) internal {}',
      '    function run(uint256 x) external { f(x); }',
      '}',
      '',
    ].join('\n');

    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/C.sol': source,
    });

    const heuristic = await buildProjectGraph(root, {
      cacheDir: null,
      workers: 1,
      enrich: false,
      callResolutionThreshold: 0,
    });
    const ambiguous = heuristic.file.edges.filter((e) => e.resolution === 'ambiguous');
    // §4: nothing syntactic chooses between the overloads, so both are emitted.
    expect(ambiguous).toHaveLength(2);

    writeBuildInfo(root, 'out/build-info', 'x.json', {
      solcVersion: '0.8.24',
      sources: {
        'src/C.sol': {
          content: source,
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 1,
              src: at(source, 'contract C {'),
              name: 'C',
              nodes: [
                {
                  nodeType: 'FunctionDefinition',
                  id: 2,
                  src: at(source, 'function f(uint256 a) internal {}'),
                  name: 'f',
                },
                {
                  nodeType: 'FunctionDefinition',
                  id: 3,
                  src: at(source, 'function f(address a) internal {}'),
                  name: 'f',
                },
                {
                  nodeType: 'FunctionDefinition',
                  id: 4,
                  src: at(source, 'function run(uint256 x) external { f(x); }'),
                  name: 'run',
                  body: {
                    nodeType: 'Block',
                    statements: [
                      {
                        nodeType: 'FunctionCall',
                        src: at(source, 'f(x)'),
                        expression: {
                          nodeType: 'Identifier',
                          src: at(source, 'f(x)'),
                          referencedDeclaration: 2,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    });

    const { file } = await build(root);

    expect(edgesBetween(file.edges, 'src/C.sol:C.run(uint256)', 'src/C.sol:C.f(uint256)')).toEqual([
      expect.objectContaining({ resolution: 'semantic' }),
    ]);
    // The candidate the compiler ruled out is gone. Keeping it would mean
    // `full` mode asserting a call that does not happen.
    expect(edgesBetween(file.edges, 'src/C.sol:C.run(uint256)', 'src/C.sol:C.f(address)')).toEqual(
      [],
    );
    expect(file.score.overall.ambiguous).toBe(0);
  });

  it('reports a heuristic target the compiler disagrees with, and follows the compiler', async () => {
    const source = [
      'pragma solidity ^0.8.20;',
      'contract C {',
      '    function a() internal {}',
      '    function b() internal {}',
      '    function run() external { a(); }',
      '}',
      '',
    ].join('\n');

    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/C.sol': source,
    });

    // A deliberate lie: the compiler says this call site is `b`. Nothing in the
    // real world produces this — it is what a resolver bug would look like from
    // the semantic tier's side, and §7 says such a difference is a bug to fix
    // rather than a difference to live with, so it has to be visible.
    writeBuildInfo(root, 'out/build-info', 'x.json', {
      solcVersion: '0.8.24',
      sources: {
        'src/C.sol': {
          content: source,
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 1,
              src: at(source, 'contract C {'),
              name: 'C',
              nodes: [
                { nodeType: 'FunctionDefinition', id: 2, src: at(source, 'function a() internal {}'), name: 'a' },
                { nodeType: 'FunctionDefinition', id: 3, src: at(source, 'function b() internal {}'), name: 'b' },
                {
                  nodeType: 'FunctionDefinition',
                  id: 4,
                  src: at(source, 'function run() external { a(); }'),
                  name: 'run',
                  body: {
                    nodeType: 'Block',
                    statements: [
                      {
                        nodeType: 'FunctionCall',
                        src: at(source, 'a()', source.indexOf('run')),
                        expression: {
                          nodeType: 'Identifier',
                          src: at(source, 'a()', source.indexOf('run')),
                          referencedDeclaration: 3,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    });

    const { file } = await build(root);

    const [edge] = edgesBetween(file.edges, 'src/C.sol:C.run()', 'src/C.sol:C.b()');
    expect(edge?.resolution).toBe('semantic');
    expect(edgesBetween(file.edges, 'src/C.sol:C.run()', 'src/C.sol:C.a()')).toEqual([]);
    expect(
      file.diagnostics.filter(
        (d) => d.severity === 'warning' && d.message.includes('compiler binds it to'),
      ),
    ).toHaveLength(1);
  });

  it('enriches the files that still match and leaves the edited one alone', async () => {
    // The normal state of a working tree: you changed one file, and the other
    // forty artifacts are still current. Enriching the edited file would use
    // offsets from the version before the edit, and every click in it would
    // land somewhere else — worse than not enriching it at all.
    const stable = [
      'pragma solidity ^0.8.20;',
      'contract A {',
      '    function inner() internal {}',
      '    function outer() external { inner(); }',
      '}',
      '',
    ].join('\n');
    const edited = [
      'pragma solidity ^0.8.20;',
      'contract B {',
      '    function inner() internal {}',
      '    function outer() external { inner(); }',
      '}',
      '',
    ].join('\n');

    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/A.sol': stable,
      'src/B.sol': edited,
    });

    const pair = (source: string, contract: string, ids: [number, number, number]): AstNode[] => [
      {
        nodeType: 'ContractDefinition',
        id: ids[0],
        src: at(source, `contract ${contract} {`),
        name: contract,
        nodes: [
          {
            nodeType: 'FunctionDefinition',
            id: ids[1],
            src: at(source, 'function inner() internal {}'),
            name: 'inner',
          },
          {
            nodeType: 'FunctionDefinition',
            id: ids[2],
            src: at(source, 'function outer() external { inner(); }'),
            name: 'outer',
            body: {
              nodeType: 'Block',
              statements: [
                {
                  nodeType: 'FunctionCall',
                  src: at(source, 'inner()', source.indexOf('outer')),
                  expression: {
                    nodeType: 'Identifier',
                    src: at(source, 'inner()', source.indexOf('outer')),
                    referencedDeclaration: ids[1],
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    writeBuildInfo(root, 'out/build-info', 'x.json', {
      solcVersion: '0.8.24',
      sources: {
        'src/A.sol': { content: stable, nodes: pair(stable, 'A', [1, 2, 3]) },
        // Compiled before the comment below was added, so the bytes no longer
        // match and every offset in it is one line out.
        'src/B.sol': {
          content: edited.replace('contract B {', '// added later\ncontract B {'),
          nodes: pair(edited, 'B', [11, 12, 13]),
        },
      },
    });

    const { file, semantic } = await build(root);

    expect(semantic?.covered).toBe(1);
    expect(semantic?.stale).toBe(1);
    expect(file.diagnostics.some((d) => d.message.includes('1 source file has changed'))).toBe(
      true,
    );

    expect(edgesBetween(file.edges, 'src/A.sol:A.outer()', 'src/A.sol:A.inner()')[0]?.resolution).toBe(
      'semantic',
    );
    expect(edgesBetween(file.edges, 'src/B.sol:B.outer()', 'src/B.sol:B.inner()')[0]?.resolution).toBe(
      'heuristic',
    );
  });

  it('does not trust a storage layout from an artifact with a stale source', async () => {
    // Slots are a whole-program property: `Derived`'s first variable sits at
    // whatever slot `Base` left free. So an artifact whose `Base` no longer
    // matches disk can hand back a perfectly well-formed layout for a `Derived`
    // that *does* match, computed against a base that has since changed. A
    // wrong slot is worse than no slot — §16's storage-collision work would
    // read it as fact.
    const base = ['pragma solidity ^0.8.20;', 'contract Base {', '    uint256 a;', '}', ''].join('\n');
    const derived = [
      'pragma solidity ^0.8.20;',
      'import "./Base.sol";',
      'contract Derived is Base {',
      '    uint256 b;',
      '}',
      '',
    ].join('\n');

    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/Base.sol': base,
      'src/Derived.sol': derived,
    });

    writeBuildInfo(root, 'out/build-info', 'x.json', {
      solcVersion: '0.8.24',
      sources: {
        // Compiled when Base had two variables; someone has since deleted one.
        'src/Base.sol': {
          content: base.replace('    uint256 a;', '    uint256 a;\n    uint256 gone;'),
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 1,
              src: at(base, 'contract Base {'),
              name: 'Base',
              nodes: [{ nodeType: 'VariableDeclaration', id: 2, src: at(base, 'uint256 a;'), name: 'a' }],
            },
          ],
        },
        'src/Derived.sol': {
          content: derived,
          nodes: [
            {
              nodeType: 'ContractDefinition',
              id: 11,
              src: at(derived, 'contract Derived is Base {'),
              name: 'Derived',
              nodes: [
                { nodeType: 'VariableDeclaration', id: 12, src: at(derived, 'uint256 b;'), name: 'b' },
              ],
            },
          ],
          storage: {
            // Slot 2 was true when Base had two variables. Today `b` is slot 1.
            storage: [{ astId: 12, contract: 'src/Derived.sol:Derived', label: 'b', offset: 0, slot: '2' }],
          },
        },
      },
    });

    const { file } = await build(root);
    const b = file.nodes.find((n) => n.id === 'src/Derived.sol:Derived.b');
    expect(b?.kind).toBe('StateVariable');
    expect('slot' in (b ?? {})).toBe(false);
  });

  it('discovers build-info in an order that does not depend on mtimes', () => {
    const root = project({ 'foundry.toml': '[profile.default]\nsrc = "src"\n' });
    fs.mkdirSync(path.join(root, 'out', 'build-info'), { recursive: true });
    for (const name of ['aaa.json', 'bbb.json']) {
      fs.writeFileSync(path.join(root, 'out', 'build-info', name), '{}');
    }

    const order = (): string[] =>
      discoverBuildInfo(detectProject(root)).map((file) => path.basename(file));

    // Whatever a checkout happened to do to the timestamps.
    fs.utimesSync(path.join(root, 'out', 'build-info', 'bbb.json'), new Date(1000), new Date(1000));
    fs.utimesSync(path.join(root, 'out', 'build-info', 'aaa.json'), new Date(2000), new Date(2000));
    const first = order();
    fs.utimesSync(path.join(root, 'out', 'build-info', 'bbb.json'), new Date(3000), new Date(3000));

    // Ordering decides which artifact owns a source when two cover it, so an
    // mtime-dependent order means a graph built from a fresh clone can differ
    // from one built in place — and `axiomap diff` reports it as a code change.
    expect(order()).toEqual(first);
    expect(first).toEqual(['aaa.json', 'bbb.json']);
  });

  it('does not report a superseded artifact as a stale source', async () => {
    // The normal Foundry state: `out/build-info/` accumulates a file per
    // compile and nothing prunes it. The old ones do not match the source any
    // more, which is not news and must not be reported as a changed file.
    const source = ['pragma solidity ^0.8.20;', 'contract C {', '    function f() external {}', '}', ''].join('\n');
    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/C.sol': source,
    });

    const nodes = (): AstNode[] => [
      {
        nodeType: 'ContractDefinition',
        id: 1,
        src: at(source, 'contract C {'),
        name: 'C',
        nodes: [
          {
            nodeType: 'FunctionDefinition',
            id: 2,
            src: at(source, 'function f() external {}'),
            name: 'f',
            functionSelector: '26121ff0',
          },
        ],
      },
    ];

    writeBuildInfo(root, 'out/build-info', 'aaa-old.json', {
      solcVersion: '0.8.20',
      sources: { 'src/C.sol': { content: '// an older revision\n', nodes: nodes() } },
    });
    writeBuildInfo(root, 'out/build-info', 'bbb-current.json', {
      solcVersion: '0.8.24',
      sources: { 'src/C.sol': { content: source, nodes: nodes() } },
    });

    const { file, semantic } = await build(root);
    expect(semantic?.covered).toBe(1);
    expect(semantic?.stale).toBe(0);
    expect(file.diagnostics.some((d) => d.message.includes('changed since'))).toBe(false);
    // The artifact that still matches is the one that was used.
    expect(file.generator.compilers).toEqual(['0.8.24']);
  });

  it('leaves a relation the compiler does not state alone', async () => {
    // `inherits`, `overrides`, `implements` and `modifiedBy` are confirmed as
    // relations rather than at a site, because their drafts carry the
    // declaration's own SourceRef. An artifact that does not state the relation
    // is not evidence against it — the edge keeps the heuristic label it earned
    // rather than being dropped or upgraded.
    const source = [
      'pragma solidity ^0.8.20;',
      'contract Base {}',
      'contract Derived is Base {}',
      '',
    ].join('\n');

    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/C.sol': source,
    });

    writeBuildInfo(root, 'out/build-info', 'x.json', {
      solcVersion: '0.8.24',
      sources: {
        'src/C.sol': {
          content: source,
          nodes: [
            { nodeType: 'ContractDefinition', id: 1, src: at(source, 'contract Base {}'), name: 'Base' },
            {
              nodeType: 'ContractDefinition',
              id: 2,
              src: at(source, 'contract Derived is Base {}'),
              name: 'Derived',
              // No `baseContracts`, as an AST from a solc version that spelled
              // it differently would look.
            },
          ],
        },
      },
    });

    const { file } = await build(root);
    const [edge] = edgesBetween(file.edges, 'src/C.sol:Derived', 'src/C.sol:Base');
    expect(edge?.kind).toBe('inherits');
    expect(edge?.resolution).toBe('heuristic');
  });

  it('ignores a build-info it cannot make sense of', async () => {
    const source = 'pragma solidity ^0.8.20;\ncontract C {}\n';
    const root = project({
      'foundry.toml': '[profile.default]\nsrc = "src"\n',
      'src/C.sol': source,
    });
    fs.mkdirSync(path.join(root, 'out', 'build-info'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'build-info', 'broken.json'), '{ not json');
    fs.writeFileSync(
      path.join(root, 'out', 'build-info', 'no-ast.json'),
      JSON.stringify({ solcVersion: '0.8.24', input: { sources: {} }, output: { sources: {} } }),
    );

    const { file, semantic } = await build(root);
    // The load comes back with no overlay rather than not at all, so the
    // "there are artifacts here and they are no good" warnings still reach the
    // build summary.
    expect(semantic?.overlay ?? null).toBeNull();
    expect(file.mode).not.toBe('full');
    expect(file.diagnostics.filter((d) => d.message.startsWith('Ignoring build-info'))).toHaveLength(
      2,
    );
  });
});
