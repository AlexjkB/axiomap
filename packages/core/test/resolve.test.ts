/**
 * Heuristic resolution, asserted against hand-read fixture sources.
 *
 * The golden files catch *changes*; this suite states what the answers should
 * be, so that a golden update has something to be checked against. Every
 * expectation below was derived by reading the fixture, and the ones that
 * assert a non-answer — `ambiguous`, `unresolved`, no edge at all — matter as
 * much as the ones that assert a target. §6: honest uncertainty is the product.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildProjectGraph, type GraphEdge, type GraphFile } from '../src/index.js';
import { graphOf, graphWithoutModeGating } from './graphs.js';

function edgesFrom(file: GraphFile, from: string, kind?: string): GraphEdge[] {
  return file.edges.filter((e) => e.from === from && (kind === undefined || e.kind === kind));
}

function edge(file: GraphFile, from: string, to: string, kind?: string): GraphEdge | undefined {
  return file.edges.find(
    (e) => e.from === from && e.to === to && (kind === undefined || e.kind === kind),
  );
}

const temporaryDirs: string[] = [];

/** A throwaway Foundry project, for cases no committed fixture covers. */
async function inlineProject(files: Record<string, string>): Promise<GraphFile> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-resolve-'));
  temporaryDirs.push(root);
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\nsrc = "src"\n');
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  // Threshold pinned to 0: these projects are three lines long, so one honest
  // ambiguity is enough to drop them into structural mode and take the call
  // edges away from the assertion. Mode selection has its own tests.
  const built = await buildProjectGraph(root, {
    cacheDir: null,
    workers: 1,
    callResolutionThreshold: 0,
  });
  return built.file;
}

afterAll(() => {
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('minimal — every edge kind, once', () => {
  const VAULT = 'src/Vault.sol:Vault';
  const deposit = `${VAULT}.deposit(uint256)`;

  it('emits every edge kind in §10', async () => {
    const { file } = await graphOf('minimal');
    const kinds = new Set(file.edges.map((e) => e.kind));
    expect([...kinds].sort()).toEqual([
      'calls',
      'creates',
      'declares',
      'emits',
      'implements',
      'inherits',
      'modifiedBy',
      'overrides',
      'reads',
      'reverts',
      'writes',
    ]);
  });

  it('emits every call subkind the fixture contains', async () => {
    const { file } = await graphOf('minimal');
    const subkinds = new Set(
      file.edges.filter((e) => e.kind === 'calls').map((e) => e.subkind ?? '-'),
    );
    expect([...subkinds].sort()).toEqual([
      'delegatecall',
      'external',
      'internal',
      'library',
      'lowlevel',
      'super',
    ]);
  });

  it('resolves an internal call to the same contract', async () => {
    const { file } = await graphOf('minimal');
    const found = edge(file, deposit, `${VAULT}._record(uint256)`, 'calls');
    expect(found?.resolution).toBe('heuristic');
    expect(found?.subkind).toBe('internal');
    // §10: the edge's src is the call site, inside `deposit`.
    expect(found?.src.line).toBe(39);
  });

  it('resolves an external call through a state variable of contract type', async () => {
    const { file } = await graphOf('minimal');
    const found = edge(file, deposit, 'src/Token.sol:Token.mint(address,uint256)', 'calls');
    expect(found?.resolution).toBe('heuristic');
    expect(found?.subkind).toBe('external');
  });

  it('resolves `using MathLib for uint256` to the library function', async () => {
    const { file } = await graphOf('minimal');
    const found = edge(
      file,
      `${VAULT}.totalAssets()`,
      'src/Types.sol:MathLib.half(uint256)',
      'calls',
    );
    expect(found?.subkind).toBe('library');
    expect(found?.resolution).toBe('heuristic');
  });

  it('resolves a file-level free function through an import', async () => {
    const { file } = await graphOf('minimal');
    const found = edge(
      file,
      `${VAULT}.totalAssets()`,
      'src/Types.sol:scale(uint256,uint256)',
      'calls',
    );
    expect(found?.resolution).toBe('heuristic');
  });

  it('resolves `super.tag()` to the base implementation', async () => {
    const { file } = await graphOf('minimal');
    const found = edge(file, `${VAULT}.tag()`, 'src/Base.sol:Base.tag()', 'calls');
    expect(found?.subkind).toBe('super');
    expect(found?.resolution).toBe('heuristic');
  });

  it('resolves `new Token()` to a creates edge, not a call', async () => {
    const { file } = await graphOf('minimal');
    const found = edge(file, `${VAULT}.constructor(address)`, 'src/Token.sol:Token', 'creates');
    expect(found?.resolution).toBe('heuristic');
    expect(edgesFrom(file, `${VAULT}.constructor(address)`, 'calls')).toEqual([]);
  });

  it('resolves an inherited modifier and an inherited event', async () => {
    const { file } = await graphOf('minimal');
    expect(edge(file, `${VAULT}.sweep(address payable)`, 'src/Base.sol:Base#onlyOwner')?.kind).toBe(
      'modifiedBy',
    );
    expect(
      edge(file, deposit, 'src/IVault.sol:IVault^Deposited(address,uint256)')?.kind,
    ).toBe('emits');
  });

  it('resolves `revert` to a file-level error reached through an import', async () => {
    const { file } = await graphOf('minimal');
    const found = edge(
      file,
      'src/Base.sol:Base#onlyOwner',
      'src/Types.sol:!NotAuthorized(address)',
      'reverts',
    );
    expect(found?.resolution).toBe('heuristic');
  });

  it('separates overrides from implements', async () => {
    const { file } = await graphOf('minimal');
    // `tag` overrides a base with a body; `deposit` implements an interface.
    expect(edge(file, `${VAULT}.tag()`, 'src/Base.sol:Base.tag()', 'overrides')).toBeDefined();
    expect(
      edge(file, deposit, 'src/IVault.sol:IVault.deposit(uint256)', 'implements'),
    ).toBeDefined();
  });

  it('marks low-level calls unresolved with a reason, not guessed', async () => {
    const { file } = await graphOf('minimal');
    const lowLevel = edge(file, `${VAULT}.sweep(address payable)`, '?low-level:call', 'calls');
    expect(lowLevel?.resolution).toBe('unresolved');
    expect(lowLevel?.subkind).toBe('lowlevel');
    expect(lowLevel?.reason).toMatch(/determined at runtime/);

    const delegate = edge(file, `${VAULT}.upgrade(bytes)`, '?low-level:delegatecall', 'calls');
    expect(delegate?.subkind).toBe('delegatecall');
    expect(delegate?.resolution).toBe('unresolved');
  });

  it('does not turn a struct literal into a call edge', async () => {
    const { file } = await graphOf('minimal');
    expect(file.edges.some((e) => e.to.includes('~Deposit') && e.kind === 'calls')).toBe(false);
    expect(file.edges.some((e) => e.to.endsWith(':Deposit'))).toBe(false);
  });

  it('does not read a state variable that shares a name with a struct field', async () => {
    // `Deposit({owner: msg.sender, ...})` names a field, not `Base.owner`.
    const { file } = await graphOf('minimal');
    expect(edge(file, deposit, 'src/Base.sol:Base.owner', 'reads')).toBeUndefined();
  });

  it('records reads and writes separately for a compound assignment', async () => {
    const { file } = await graphOf('minimal');
    expect(edge(file, deposit, `${VAULT}.assets`, 'reads')).toBeDefined();
    expect(edge(file, deposit, `${VAULT}.assets`, 'writes')).toBeDefined();
  });

  it('collapses repeated call sites into one weighted edge', async () => {
    const { file } = await graphOf('minimal');
    // `return assets.half() + scale(assets, 2)` reads `assets` twice.
    const reads = edge(file, `${VAULT}.totalAssets()`, `${VAULT}.assets`, 'reads');
    expect(reads?.count).toBe(2);
    expect(reads?.sites).toHaveLength(2);
  });
});

describe('inheritance — linearization and shadowing', () => {
  it('walks super in C3 order, which depends on base declaration order', async () => {
    const { file } = await graphOf('inheritance');
    // D is B, C → [D, C, B, A]; E is C, B → [E, B, C, A].
    expect(
      edge(file, 'src/Diamond.sol:D.ping()', 'src/Diamond.sol:C.ping()', 'calls')?.subkind,
    ).toBe('super');
    expect(
      edge(file, 'src/Diamond.sol:E.ping()', 'src/Diamond.sol:B.ping()', 'calls')?.subkind,
    ).toBe('super');
  });

  it('records the full linearization on the contract node', async () => {
    const { file } = await graphOf('inheritance');
    const d = file.nodes.find((n) => n.id === 'src/Diamond.sol:D');
    expect(d?.kind).toBe('Contract');
    if (d?.kind !== 'Contract') throw new Error('unreachable');
    expect(d.linearizedBases).toEqual([
      'src/Diamond.sol:D',
      'src/Diamond.sol:C',
      'src/Diamond.sol:B',
      'src/Diamond.sol:A',
    ]);
    expect(d.linearizationCertainty).toBe('certain');
  });

  it('walks super through a remapped dependency', async () => {
    const { file } = await graphOf('inheritance');
    const found = edge(
      file,
      'src/GovernedToken.sol:GovernedToken._update(address,address,uint256)',
      'lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Pausable.sol:ERC20Pausable._update(address,address,uint256)',
      'calls',
    );
    expect(found?.subkind).toBe('super');
    expect(found?.resolution).toBe('heuristic');
  });

  it('emits an overrides edge for each base named in override(A, B)', async () => {
    const { file } = await graphOf('inheritance');
    const from = 'src/GovernedToken.sol:GovernedToken._update(address,address,uint256)';
    const targets = edgesFrom(file, from, 'overrides').map((e) => e.to);
    expect(targets).toContain(
      'lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol:ERC20._update(address,address,uint256)',
    );
    expect(targets).toContain(
      'lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Pausable.sol:ERC20Pausable._update(address,address,uint256)',
    );
  });

  it('treats a base constructor invocation as a call, not a modifier', async () => {
    const { file } = await graphOf('inheritance');
    const from = 'src/GovernedToken.sol:GovernedToken.constructor(address)';
    const targets = edgesFrom(file, from, 'calls').map((e) => e.to);
    expect(targets).toContain(
      'lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol:ERC20.constructor(string,string)',
    );
    expect(edgesFrom(file, from, 'modifiedBy')).toEqual([]);
  });

  it('lets a local shadow an inherited state variable', async () => {
    const { file } = await graphOf('inheritance');
    // Politeness.greet declares `string memory _greeting`; Greeter.greet reads
    // the state variable of the same name.
    expect(
      edge(file, 'src/Shadowing.sol:Politeness.greet()', 'src/Shadowing.sol:Greeter._greeting'),
    ).toBeUndefined();
    expect(
      edge(
        file,
        'src/Shadowing.sol:Greeter.greet()',
        'src/Shadowing.sol:Greeter._greeting',
        'reads',
      ),
    ).toBeDefined();
  });

  it('marks a contract with an unimplemented inherited function as not fully implemented', async () => {
    const { file } = await graphOf('inheritance');
    const greeter = file.nodes.find((n) => n.id === 'src/Shadowing.sol:Greeter');
    const loud = file.nodes.find((n) => n.id === 'src/Shadowing.sol:Loud');
    if (greeter?.kind !== 'Contract' || loud?.kind !== 'Contract') {
      throw new Error('unreachable');
    }
    expect(greeter.isFullyImplemented).toBe(false);
    expect(loud.isFullyImplemented).toBe(true);
  });
});

describe('defi — cross-contract calls across a trust boundary', () => {
  it('points an interface call at the interface and lists implementations', async () => {
    const { file } = await graphOf('defi');
    const found = edge(
      file,
      'src/Router.sol:Router.addLiquidity(address,address,uint256,uint256,address,uint256)',
      'src/interfaces/IAmm.sol:IPair.mint(address)',
      'calls',
    );
    expect(found?.crossTrustBoundary).toBe(true);
    expect(found?.possibleTargets).toEqual(['src/Pair.sol:Pair.mint(address)']);
  });

  it('leaves possibleTargets empty when nothing in the project implements the interface', async () => {
    const { file } = await graphOf('defi');
    const found = edge(
      file,
      'src/Pair.sol:Pair.mint(address)',
      'src/interfaces/IAmm.sol:IERC20Minimal.balanceOf(address)',
      'calls',
    );
    expect(found?.crossTrustBoundary).toBe(true);
    expect(found?.possibleTargets).toEqual([]);
  });

  it('resolves `using SafeTransfer for address` on a state variable', async () => {
    const { file } = await graphOf('defi');
    const found = edge(
      file,
      'src/Pair.sol:Pair.burn(address)',
      'src/libraries/AmmMath.sol:SafeTransfer.safeTransfer(address,address,uint256)',
      'calls',
    );
    expect(found?.subkind).toBe('library');
    expect(found?.resolution).toBe('heuristic');
  });

  it('resolves `using AmmMath for uint256` on a parameter', async () => {
    const { file } = await graphOf('defi');
    const found = edge(
      file,
      'src/Router.sol:Router.quote(uint256,uint256,uint256)',
      'src/libraries/AmmMath.sol:AmmMath.quote(uint256,uint256,uint256)',
      'calls',
    );
    expect(found?.subkind).toBe('library');
  });

  it('records create2 as a creates edge and sets hasCreate', async () => {
    const { file } = await graphOf('defi');
    const from = 'src/Factory.sol:Factory.createPair(address,address)';
    expect(edge(file, from, 'src/Pair.sol:Pair', 'creates')?.resolution).toBe('heuristic');
    const node = file.nodes.find((n) => n.id === from);
    if (node?.kind !== 'Function') throw new Error('unreachable');
    expect(node.flags.hasCreate).toBe(true);
  });
});

describe('pathological — the answers that are non-answers', () => {
  it('reports a function pointer call as unresolved, with the reason', async () => {
    const { file } = await graphWithoutModeGating('pathological');
    const found = edge(file, 'src/Indirect.sol:Indirect.apply_(uint256)', '?function-pointer:transform', 'calls');
    expect(found?.resolution).toBe('unresolved');
    expect(found?.reason).toBe('call through a function pointer');
  });

  it('reports selector dispatch as an unresolved low-level call', async () => {
    const { file } = await graphWithoutModeGating('pathological');
    const found = edge(file, 'src/Indirect.sol:Indirect.raw(bytes4,uint256)', '?low-level:call', 'calls');
    expect(found?.subkind).toBe('lowlevel');
    expect(found?.resolution).toBe('unresolved');
  });

  it('reports a call to a function that does not exist as unresolved', async () => {
    const { file } = await graphWithoutModeGating('pathological');
    expect(
      edge(file, 'src/DoesNotCompile.sol:DoesNotCompile.increment()', '?not-found:undeclaredHelper', 'calls')
        ?.resolution,
    ).toBe('unresolved');
  });

  it('still graphs the file that does not compile', async () => {
    const { file } = await graphWithoutModeGating('pathological');
    // Decision #1: the rest of the file resolves normally.
    expect(
      edge(
        file,
        'src/DoesNotCompile.sol:DoesNotCompile.alsoBroken()',
        'src/DoesNotCompile.sol:DoesNotCompile.identity(uint256)',
        'calls',
      )?.resolution,
    ).toBe('heuristic');
  });

  it('keeps two contracts of the same name distinct', async () => {
    const { file } = await graphOf('pathological');
    const duplicates = file.nodes.filter((n) => n.kind === 'Contract' && n.name === 'Duplicate');
    expect(duplicates.map((n) => n.id).sort()).toEqual([
      'src/dup-a/Duplicate.sol:Duplicate',
      'src/dup-b/Duplicate.sol:Duplicate',
    ]);
  });

  it('records an unresolvable import on the source unit without failing', async () => {
    const { file } = await graphOf('pathological');
    const unit = file.nodes.find((n) => n.id === 'src/BadImport.sol');
    if (unit?.kind !== 'SourceUnit') throw new Error('unreachable');
    expect(unit.unresolvedImports).toEqual([
      '@nonexistent/package/Missing.sol',
      './does/not/exist/Ghost.sol',
    ]);
  });

  it('resolves a public state variable getter called across contracts', async () => {
    const { file } = await graphWithoutModeGating('pathological');
    const found = edge(
      file,
      'src/BadImport.sol:BadImport.poke()',
      'src/Assembly.sol:Assembly.slot0',
      'calls',
    );
    expect(found?.subkind).toBe('external');
  });

  it('attributes storage access inside assembly to the function, not to a variable', async () => {
    const { file } = await graphOf('pathological');
    const write = file.nodes.find((n) => n.id === 'src/Assembly.sol:Assembly.writeRaw(uint256,bytes32)');
    if (write?.kind !== 'Function') throw new Error('unreachable');
    expect(write.flags.writesState).toBe(true);
    expect(write.flags.hasAssembly).toBe(true);
    // No `writes` edge: `sstore(slot, value)` names no declaration to bind.
    expect(edgesFrom(file, write.id, 'writes')).toEqual([]);
  });

  it('excludes a sub-0.8 file from the resolution score but still graphs it', async () => {
    const { file } = await graphOf('pathological');
    expect(file.score.excludedFiles).toBe(1);
    expect(file.nodes.some((n) => n.id === 'src/Legacy.sol:Legacy')).toBe(true);
    expect(
      file.edges.some((e) => e.src.file === 'src/Legacy.sol' && e.kind === 'reads'),
    ).toBe(true);
  });
});

describe('ambiguity is emitted, never resolved by guessing', () => {
  it('fans out to every overload when the argument type needs inference', async () => {
    const file = await inlineProject({
      'src/Overloads.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Overloads {
    function pick(uint256 a) public pure returns (uint256) { return a; }
    function pick(address a) public pure returns (uint256) { return uint256(uint160(a)); }
    function caller(uint256 x) external pure returns (uint256) { return pick(x); }
}
`,
    });

    const from = 'src/Overloads.sol:Overloads.caller(uint256)';
    const calls = file.edges.filter((e) => e.from === from && e.kind === 'calls');
    expect(calls.map((e) => e.to).sort()).toEqual([
      'src/Overloads.sol:Overloads.pick(address)',
      'src/Overloads.sol:Overloads.pick(uint256)',
    ]);
    for (const call of calls) {
      expect(call.resolution).toBe('ambiguous');
      expect(call.reason).toMatch(/overloads/);
    }
  });

  it('marks both candidates ambiguous when two contracts share a name', async () => {
    const file = await inlineProject({
      'src/a/Dup.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Dup { function ping() external {} }
`,
      'src/b/Dup.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Dup { function ping() external {} }
`,
      'src/User.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract User is Dup {}
`,
    });

    const inherits = file.edges.filter((e) => e.kind === 'inherits');
    expect(inherits).toHaveLength(2);
    for (const found of inherits) expect(found.resolution).toBe('ambiguous');

    const user = file.nodes.find((n) => n.id === 'src/User.sol:User');
    if (user?.kind !== 'Contract') throw new Error('unreachable');
    expect(user.linearizationCertainty).toBe('ambiguous');
  });

  it('downgrades super to ambiguous when the chain could not be linearized', async () => {
    const file = await inlineProject({
      'src/Missing.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Absent} from "./nowhere/Absent.sol";

contract Child is Absent {
    function ping() public virtual { }
}
`,
    });
    const child = file.nodes.find((n) => n.id === 'src/Missing.sol:Child');
    if (child?.kind !== 'Contract') throw new Error('unreachable');
    expect(child.linearizationCertainty).toBe('ambiguous');
    expect(
      file.edges.some((e) => e.to === '?not-found:Absent' && e.kind === 'inherits'),
    ).toBe(true);
  });
});
