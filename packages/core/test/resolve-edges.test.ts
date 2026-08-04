/**
 * The resolution branches no committed fixture reaches.
 *
 * Coverage over `resolve/` found these unexercised, and untested code in the
 * resolution path is the same liability §7 called an untested tolerant parser:
 * every later phase reads these edges, and a branch nothing runs is a branch
 * nobody has checked the answer of. Each case below is a small inline project
 * rather than a fixture change, because the committed fixtures have
 * hand-verified counts that Phase 1 asserts.
 *
 * The malformed-inheritance cases matter most. A tolerant parser (decision #1)
 * will hand the resolver hierarchies solc would reject outright, and the
 * requirement is not that they resolve — it is that they terminate, say they
 * are uncertain, and never invent an answer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildProjectGraph, type GraphFile } from '../src/index.js';

const temporaryDirs: string[] = [];

async function project(files: Record<string, string>): Promise<GraphFile> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiomap-edges-'));
  temporaryDirs.push(root);
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\nsrc = "src"\n');
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  const built = await buildProjectGraph(root, {
    cacheDir: null,
    workers: 1,
    callResolutionThreshold: 0,
  });
  return built.file;
}

const sol = (body: string): string => `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\n${body}`;

function targets(file: GraphFile, from: string, kind: string): string[] {
  return file.edges
    .filter((e) => e.from === from && e.kind === kind)
    .map((e) => e.to)
    .sort();
}

afterAll(() => {
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('call shapes with no fixture coverage', () => {
  it('resolves `this.f()` as an external call to the contract itself', async () => {
    const file = await project({
      'src/Self.sol': sol(`contract Self {
    function outer() external { this.inner(1); }
    function inner(uint256 a) public pure returns (uint256) { return a; }
}`),
    });
    const call = file.edges.find(
      (e) => e.from === 'src/Self.sol:Self.outer()' && e.kind === 'calls',
    );
    expect(call?.to).toBe('src/Self.sol:Self.inner(uint256)');
    // `this.f()` is a real external call — it goes through the dispatcher, and
    // an auditor reading the attack surface needs to see it that way.
    expect(call?.subkind).toBe('external');
    expect(call?.resolution).toBe('heuristic');
  });

  it('resolves a free function called through an `import * as` namespace', async () => {
    const file = await project({
      'src/Free.sol': sol(`function twice(uint256 a) pure returns (uint256) { return a * 2; }`),
      'src/User.sol': sol(`import * as H from "./Free.sol";

contract User {
    function go(uint256 a) external pure returns (uint256) { return H.twice(a); }
}`),
    });
    expect(file.nodes.some((n) => n.kind === 'Unresolved')).toBe(false);
    expect(targets(file, 'src/User.sol:User.go(uint256)', 'calls')).toEqual([
      'src/Free.sol:twice(uint256)',
    ]);
  });

  it('reports a nested namespace member as unresolved rather than guessing', async () => {
    // `H.Helpers.twice(a)` — the receiver is itself a member expression, so
    // nothing syntactically names its type. Resolvable in principle by walking
    // the namespace two levels; §16 has it, and until then the honest answer
    // is `dynamic-receiver`.
    const file = await project({
      'src/Lib.sol': sol(`library Helpers {
    function twice(uint256 a) internal pure returns (uint256) { return a * 2; }
}`),
      'src/User.sol': sol(`import * as H from "./Lib.sol";

contract User {
    function go(uint256 a) external pure returns (uint256) { return H.Helpers.twice(a); }
}`),
    });
    const call = file.edges.find(
      (e) => e.from === 'src/User.sol:User.go(uint256)' && e.kind === 'calls',
    );
    expect(call?.resolution).toBe('unresolved');
    expect(call?.to).toBe('?dynamic-receiver:twice');
  });

  it('brings every top-level name into scope through a bare import', async () => {
    const file = await project({
      'src/Free.sol': sol(`function scale(uint256 a) pure returns (uint256) { return a * 3; }`),
      'src/User.sol': sol(`import "./Free.sol";

contract User {
    function go(uint256 a) external pure returns (uint256) { return scale(a); }
}`),
    });
    expect(targets(file, 'src/User.sol:User.go(uint256)', 'calls')).toEqual([
      'src/Free.sol:scale(uint256)',
    ]);
  });

  it('resolves `using {f} for T` to the attached free function', async () => {
    const file = await project({
      'src/Attach.sol': sol(`function double(uint256 a) pure returns (uint256) { return a * 2; }

contract Attach {
    using {double} for uint256;

    function go(uint256 a) external pure returns (uint256) { return a.double(); }
}`),
    });
    expect(targets(file, 'src/Attach.sol:Attach.go(uint256)', 'calls')).toEqual([
      'src/Attach.sol:double(uint256)',
    ]);
  });

  it('reports a cast to an unknown type as unresolved', async () => {
    const file = await project({
      'src/Cast.sol': sol(`contract Cast {
    address public target;
    function go() external { IGhost(target).ping(); }
}`),
    });
    const call = file.edges.find((e) => e.kind === 'calls');
    expect(call?.resolution).toBe('unresolved');
    expect(call?.to).toBe('?not-found:ping');
    expect(call?.reason).toMatch(/cast to unknown type IGhost/);
  });

  it('reports a call through a local function pointer as unresolved', async () => {
    const file = await project({
      'src/Ptr.sol': sol(`contract Ptr {
    function pick(uint256 a) internal pure returns (uint256) { return a; }

    function go(uint256 a) external pure returns (uint256) {
        function(uint256) internal pure returns (uint256) f = pick;
        return f(a);
    }
}`),
    });
    const unresolved = file.edges.filter((e) => e.resolution === 'unresolved');
    expect(unresolved.map((e) => e.to)).toContain('?function-pointer:f');
  });
});

describe('names that resolve to nothing', () => {
  it('reports an unknown modifier as unresolved rather than dropping it', async () => {
    const file = await project({
      'src/Mod.sol': sol(`contract Mod {
    function go() external onlyGhost {}
}`),
    });
    const edge = file.edges.find((e) => e.kind === 'modifiedBy');
    expect(edge?.to).toBe('?not-found:onlyGhost');
    expect(edge?.resolution).toBe('unresolved');
  });

  it('reports an unknown event and error as unresolved', async () => {
    const file = await project({
      'src/Ref.sol': sol(`contract Ref {
    function go() external { emit Ghost(1); }
    function bad() external pure { revert Missing(); }
}`),
    });
    expect(targets(file, 'src/Ref.sol:Ref.go()', 'emits')).toEqual(['?not-found:Ghost']);
    expect(targets(file, 'src/Ref.sol:Ref.bad()', 'reverts')).toEqual(['?not-found:Missing']);
  });

  it('reports a member on an elementary type with no using-for as unattached', async () => {
    const file = await project({
      'src/Bare.sol': sol(`contract Bare {
    uint256 public total;
    function go() external view returns (uint256) { return total.rounded(); }
}`),
    });
    const call = file.edges.find((e) => e.kind === 'calls');
    expect(call?.to).toBe('?unattached-member:rounded');
    expect(call?.reason).toMatch(/attached to uint256 by a using-for directive/);
  });

  it('reports a missing member on a known contract type as unresolved', async () => {
    const file = await project({
      'src/Miss.sol': sol(`contract Other {
    function present() external {}
}

contract Miss {
    Other public other;
    function go() external { other.absent(); }
}`),
    });
    const call = file.edges.find(
      (e) => e.from === 'src/Miss.sol:Miss.go()' && e.kind === 'calls',
    );
    expect(call?.to).toBe('?not-found:absent');
    expect(call?.reason).toMatch(/no member absent on Other/);
  });

  it('reports `super` with nothing to dispatch to as unresolved', async () => {
    const file = await project({
      'src/Sup.sol': sol(`abstract contract Base {
    function ping() public virtual;
}

contract Child is Base {
    function ping() public override { super.ping(); }
}`),
    });
    // The only declaration in the chain has no body, so there is nothing for
    // `super` to reach. Guessing at `Base.ping` would be wrong: the call
    // reverts at runtime.
    const call = file.edges.find(
      (e) => e.from === 'src/Sup.sol:Child.ping()' && e.subkind === 'super',
    );
    expect(call?.resolution).toBe('unresolved');
    expect(call?.to).toBe('?not-found:ping');
  });
});

describe('malformed inheritance terminates and admits uncertainty', () => {
  it('survives a cycle without hanging, and marks the chain ambiguous', async () => {
    const file = await project({
      'src/Cycle.sol': sol(`contract A is B {
    function ping() public virtual {}
}

contract B is A {
    function pong() public virtual {}
}`),
    });
    for (const id of ['src/Cycle.sol:A', 'src/Cycle.sol:B']) {
      const node = file.nodes.find((n) => n.id === id);
      if (node?.kind !== 'Contract') throw new Error('unreachable');
      expect(node.linearizationCertainty).toBe('ambiguous');
      // Whatever the chain is, it must be finite and contain no duplicates.
      expect(new Set(node.linearizedBases).size).toBe(node.linearizedBases.length);
    }
  });

  it('marks a chain ambiguous when C3 cannot be merged', async () => {
    // `contract X is B, A` where `B is A` is the order solc rejects with
    // "Linearization of inheritance graph impossible". A tolerant parse still
    // hands it to the resolver.
    const file = await project({
      'src/Bad.sol': sol(`contract A {
    function ping() public virtual {}
}

contract B is A {
    function ping() public virtual override {}
}

contract X is B, A {
    function ping() public override { super.ping(); }
}`),
    });
    const x = file.nodes.find((n) => n.id === 'src/Bad.sol:X');
    if (x?.kind !== 'Contract') throw new Error('unreachable');
    expect(x.linearizationCertainty).toBe('ambiguous');

    // §6: never invent a resolution. Both candidates are emitted, ambiguous.
    const supers = file.edges.filter(
      (e) => e.from === 'src/Bad.sol:X.ping()' && e.subkind === 'super',
    );
    expect(supers.length).toBeGreaterThan(1);
    for (const edge of supers) {
      expect(edge.resolution).toBe('ambiguous');
      expect(edge.reason).toMatch(/could not be linearized/);
    }
  });

  it('does not crash on a contract inheriting itself', async () => {
    const file = await project({
      'src/Selfish.sol': sol(`contract Selfish is Selfish {
    function ping() public {}
}`),
    });
    const node = file.nodes.find((n) => n.id === 'src/Selfish.sol:Selfish');
    if (node?.kind !== 'Contract') throw new Error('unreachable');
    expect(node.linearizationCertainty).toBe('ambiguous');
    expect(node.linearizedBases).toEqual(['src/Selfish.sol:Selfish']);
  });
});
