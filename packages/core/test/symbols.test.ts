/**
 * Phase 1 exit criterion: a symbol table for every fixture with **hand-verified**
 * contract and function counts.
 *
 * The numbers below were counted by reading the fixture sources, not by running
 * the code and pasting the output. That distinction is the whole value of this
 * file — a count copied from a run confirms only that the code is
 * deterministic. Where a count is not obvious from a quick read, the comment
 * says where it comes from.
 *
 * `inheritance/` vendors OpenZeppelin, so its totals are not hand-countable and
 * are not asserted as totals; the hand-written contracts in it are asserted
 * exactly, and the OpenZeppelin part is asserted structurally.
 */

import { describe, expect, it } from 'vitest';

import { ingestProject } from '../src/ingest.js';
import type { ContractSymbol, FunctionSymbol, SymbolTable } from '../src/symbols/table.js';
import { lookupContracts } from '../src/symbols/table.js';
import { BACKENDS, fixture } from './fixtures.js';

async function ingest(name: string, parserId: (typeof BACKENDS)[number]): Promise<SymbolTable> {
  const result = await ingestProject(fixture(name), { parserId, cacheDir: null });
  return result.table;
}

function membersOf(table: SymbolTable, contractName: string, file?: string): ContractSymbol {
  const matches = lookupContracts(table, contractName).filter(
    (c) => file === undefined || c.file === file,
  );
  expect(matches).toHaveLength(1);
  return matches[0] as ContractSymbol;
}

function functionNames(table: SymbolTable, contract: ContractSymbol): string[] {
  return contract.members
    .map((id) => table.symbols.get(id))
    .filter((s): s is FunctionSymbol => s?.kind === 'function')
    .map((s) => s.name)
    .sort();
}

describe.each(BACKENDS)('symbol table [%s]', (parserId) => {
  describe('minimal/', () => {
    it('has the hand-counted totals', async () => {
      const table = await ingest('minimal', parserId);
      const s = table.stats;

      // 5 files: Types, IVault, Base, Token, Vault.
      expect(s.files).toBe(5);

      // Token + Vault = 2 concrete, IVault = 1 interface, MathLib = 1 library,
      // Base = 1 abstract.
      expect(s.contracts).toBe(2);
      expect(s.interfaces).toBe(1);
      expect(s.libraries).toBe(1);
      expect(s.abstractContracts).toBe(1);

      // MathLib.half 1 + free `scale` 1 + IVault 2 + Base (constructor, tag) 2
      // + Token.mint 1 + Vault (constructor, deposit, totalAssets, tag,
      // upgrade, sweep, _record) 7 = 14. Modifiers are counted separately.
      expect(s.functions).toBe(14);
      expect(s.modifiers).toBe(1);

      // MAX_DEPOSIT 1 + Base.owner 1 + Token.balanceOf 1
      // + Vault (token, assets, status, deposits, implementation) 5 = 8.
      expect(s.stateVariables).toBe(8);

      expect(s.events).toBe(2); // IVault.Deposited, Vault.Swept
      expect(s.errors).toBe(2); // NotAuthorized, Vault.DepositTooLarge
      expect(s.structs).toBe(1); // Deposit
      expect(s.enums).toBe(1); // Status
      expect(s.userDefinedValueTypes).toBe(1); // Shares

      expect(s.unresolvedImports).toBe(0);
      expect(s.filesWithErrors).toBe(0);
    });

    it('builds §8-shaped ids', async () => {
      const table = await ingest('minimal', parserId);

      expect(table.symbols.has('src/Vault.sol:Vault.deposit(uint256)')).toBe(true);
      expect(table.symbols.has('src/Vault.sol:Vault.token')).toBe(true);
      expect(table.symbols.has('src/Base.sol:Base#onlyOwner')).toBe(true);
      expect(table.symbols.has('src/Vault.sol:Vault')).toBe(true);
      // File-level declarations drop the contract scope entirely.
      expect(table.symbols.has('src/Types.sol:scale(uint256,uint256)')).toBe(true);
      expect(table.symbols.has('src/Types.sol:~Deposit')).toBe(true);
    });

    it('records contract kinds, bases and using-for', async () => {
      const table = await ingest('minimal', parserId);
      const vault = membersOf(table, 'Vault');

      expect(vault.contractKind).toBe('contract');
      expect(vault.baseNames).toEqual(['Base', 'IVault']);
      expect(vault.usingFor).toEqual([
        { libraryName: 'MathLib', functions: [], typeName: 'uint256' },
      ]);
      expect(membersOf(table, 'MathLib').contractKind).toBe('library');
      expect(membersOf(table, 'IVault').contractKind).toBe('interface');
      expect(membersOf(table, 'Base').contractKind).toBe('abstract');
    });

    it('names constructors, fallbacks and receives after their keyword', async () => {
      const table = await ingest('minimal', parserId);
      expect(functionNames(table, membersOf(table, 'Vault'))).toEqual([
        '_record',
        'constructor',
        'deposit',
        'sweep',
        'tag',
        'totalAssets',
        'upgrade',
      ]);
    });

    it('resolves every import', async () => {
      const result = await ingestProject(fixture('minimal'), { parserId, cacheDir: null });
      expect(result.table.unresolvedImports).toEqual([]);

      const vault = result.table.files.get('src/Vault.sol');
      expect(vault?.imports.map((i) => i.resolved).sort()).toEqual([
        'src/Base.sol',
        'src/IVault.sol',
        'src/Token.sol',
        'src/Types.sol',
      ]);
      // `import {Deposit, ... } from "./Types.sol"` binds each name locally.
      expect(vault?.imported.get('MathLib')).toEqual({
        fromFile: 'src/Types.sol',
        originalName: 'MathLib',
      });
    });
  });

  describe('defi/', () => {
    it('has the hand-counted totals', async () => {
      const table = await ingest('defi', parserId);
      const s = table.stats;

      expect(s.files).toBe(5);

      // Pair, Factory, Router concrete; IERC20Minimal, IPair, IFactory
      // interfaces; AmmMath, SafeTransfer libraries; Shares abstract.
      expect(s.contracts).toBe(3);
      expect(s.interfaces).toBe(3);
      expect(s.libraries).toBe(2);
      expect(s.abstractContracts).toBe(1);

      // interfaces 3+5+2 = 10, AmmMath 5, SafeTransfer 1, Shares 2, Pair 7,
      // Factory 5, Router 7 = 37.
      expect(s.functions).toBe(37);
      expect(s.modifiers).toBe(2); // Pair.lock, Router.ensure

      // AmmMath 2 constants + Shares 2 + Pair 7 + Factory 3 + Router 1 = 15.
      expect(s.stateVariables).toBe(15);
      expect(s.events).toBe(6); // IPair 4 + IFactory 1 + Shares.Transfer 1
      expect(s.errors).toBe(15); // 2 + 1 + 5 + 4 + 3
      expect(s.unresolvedImports).toBe(0);
      expect(s.filesWithErrors).toBe(0);
    });

    it('reads remappings out of foundry.toml', async () => {
      const result = await ingestProject(fixture('defi'), { parserId, cacheDir: null });
      expect(result.project.kind).toBe('foundry');
      expect(result.project.remappings).toContainEqual({
        context: null,
        prefix: '@interfaces/',
        target: 'src/interfaces/',
        source: 'foundry.toml',
      });
    });
  });

  describe('inheritance/', () => {
    it('keeps base declaration order, which C3 depends on', async () => {
      const table = await ingest('inheritance', parserId);

      // D and E have the same bases in opposite order. A resolver that sorts
      // or de-duplicates base names loses the distinction entirely.
      expect(membersOf(table, 'D').baseNames).toEqual(['B', 'C']);
      expect(membersOf(table, 'E').baseNames).toEqual(['C', 'B']);
      expect(membersOf(table, 'GovernedToken').baseNames).toEqual([
        'ERC20',
        'ERC20Burnable',
        'ERC20Pausable',
        'Ownable2Step',
      ]);
    });

    it('records explicit override base lists', async () => {
      const table = await ingest('inheritance', parserId);
      const update = table.symbols.get(
        'src/GovernedToken.sol:GovernedToken._update(address,address,uint256)',
      );

      expect(update?.kind).toBe('function');
      expect((update as FunctionSymbol).isOverride).toBe(true);
      expect((update as FunctionSymbol).overrides).toEqual(['ERC20', 'ERC20Pausable']);
    });

    it('marks an unimplemented function as bodiless', async () => {
      const table = await ingest('inheritance', parserId);
      const name = table.symbols.get('src/Shadowing.sol:Greeter.name()');
      expect((name as FunctionSymbol).hasBody).toBe(false);
      expect((name as FunctionSymbol).isVirtual).toBe(true);

      const greet = table.symbols.get('src/Shadowing.sol:Greeter.greet()');
      expect((greet as FunctionSymbol).hasBody).toBe(true);
    });

    it('resolves OpenZeppelin imports through remappings.txt', async () => {
      const result = await ingestProject(fixture('inheritance'), { parserId, cacheDir: null });

      expect(result.table.unresolvedImports).toEqual([]);
      const governed = result.table.files.get('src/GovernedToken.sol');
      expect(governed?.imports.map((i) => i.via)).toEqual([
        'remapping',
        'remapping',
        'remapping',
        'remapping',
      ]);
      expect(governed?.imports[0]?.resolved).toBe(
        'lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol',
      );
    });

    it('classifies every vendored file as within the supported band', async () => {
      // OpenZeppelin interfaces carry `pragma solidity >=0.4.16;`. That is
      // unbounded above, so solc compiles them at 0.8 and so does Axiomap.
      const table = await ingest('inheritance', parserId);
      expect(table.stats.unsupportedFiles).toBe(0);
      expect(table.stats.bestEffortFiles).toBe(0);
    });
  });

  describe('pathological/', () => {
    it('keeps both contracts that share a name', async () => {
      const table = await ingest('pathological', parserId);
      const duplicates = table.contractsByName.get('Duplicate') ?? [];

      expect(duplicates).toHaveLength(2);
      expect(duplicates.sort()).toEqual([
        'src/dup-a/Duplicate.sol:Duplicate',
        'src/dup-b/Duplicate.sol:Duplicate',
      ]);
    });

    it('records unresolved imports without dropping the file', async () => {
      const table = await ingest('pathological', parserId);

      expect(table.stats.unresolvedImports).toBe(2);
      expect(table.unresolvedImports.map((i) => i.raw).sort()).toEqual([
        './does/not/exist/Ghost.sol',
        '@nonexistent/package/Missing.sol',
      ]);
      // The importing file is still fully indexed.
      expect(table.symbols.has('src/BadImport.sol:BadImport.poke()')).toBe(true);
      // …and the import that *does* resolve still resolved.
      expect(
        table.files.get('src/BadImport.sol')?.imports.find((i) => i.raw === './Assembly.sol')
          ?.resolved,
      ).toBe('src/Assembly.sol');
    });

    it('indexes a file that does not compile', async () => {
      // Decision #1 in one assertion: semantically broken, syntactically fine,
      // fully present in the symbol table.
      const table = await ingest('pathological', parserId);
      const contract = membersOf(table, 'DoesNotCompile');

      expect(functionNames(table, contract)).toEqual([
        'alsoBroken',
        'broken',
        'identity',
        'increment',
        'noReturn',
      ]);
      expect(table.files.get('src/DoesNotCompile.sol')?.diagnosticCount).toBe(0);
    });

    it('applies the version policy per file', async () => {
      const table = await ingest('pathological', parserId);

      expect(table.files.get('src/Legacy.sol')?.versionSupport).toBe('best-effort');
      expect(table.files.get('src/Assembly.sol')?.versionSupport).toBe('supported');
      expect(table.stats.bestEffortFiles).toBe(1);
      expect(table.stats.unsupportedFiles).toBe(0);
      // Best-effort is still graphed.
      expect(table.symbols.has('src/Legacy.sol:Legacy.add(uint256)')).toBe(true);
    });

    it('records overloads as separate symbols rather than collapsing them', async () => {
      const table = await ingest('pathological', parserId);

      expect(table.symbols.has('src/Indirect.sol:Indirect.pick(uint256)')).toBe(true);
      expect(table.symbols.has('src/Indirect.sol:Indirect.pick(address)')).toBe(true);
    });

    it('marks the proxy fallback and receive', async () => {
      const table = await ingest('pathological', parserId);
      const proxy = membersOf(table, 'Proxy');
      const names = functionNames(table, proxy);

      expect(names).toContain('fallback');
      expect(names).toContain('receive');
      const fallback = table.symbols.get('src/Proxy.sol:Proxy.fallback()') as FunctionSymbol;
      expect(fallback.subkind).toBe('fallback');
      expect(fallback.stateMutability).toBe('payable');
    });
  });
});
