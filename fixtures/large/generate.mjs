#!/usr/bin/env node
/**
 * Generates the `large/` performance fixture.
 *
 * §14 wants 150+ contracts and 100k+ SLOC; §7 Phase 1's benchmark gate is
 * stated in terms of 200k SLOC, so that is the default target.
 *
 * The output is NOT committed — `fixtures/large/generated/` is gitignored and
 * this script is the fixture. Reasons, in order: it is ~8 MB of derived text in
 * a public repo, the pre-commit guard exists to keep bulk out of history, and a
 * seeded generator reproduces byte-identically anywhere, which is what a
 * benchmark actually needs. Regenerating is idempotent.
 *
 *   node fixtures/large/generate.mjs [--sloc 200000] [--out generated]
 *
 * Timing budgets are asserted against this; graph *contents* never are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Deterministic PRNG — mulberry32. Same seed, same bytes, every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODULES = [
  'vault', 'staking', 'lending', 'oracle', 'registry', 'treasury', 'bridge',
  'router', 'auction', 'escrow', 'timelock', 'distributor', 'farm', 'gauge',
  'minter', 'burner', 'adapter', 'strategy', 'controller', 'keeper',
];

const VERBS = [
  'deposit', 'withdraw', 'settle', 'accrue', 'harvest', 'rebalance', 'sync',
  'claim', 'stake', 'unstake', 'migrate', 'sweep', 'quote', 'preview',
  'compound', 'liquidate', 'redeem', 'flush', 'rollover', 'checkpoint',
];

function pick(rand, xs) {
  return xs[Math.floor(rand() * xs.length)];
}

/** One function body. Length varies so SLOC is not uniformly distributed. */
function body(rand, name, index, peers) {
  const lines = [];
  const n = 3 + Math.floor(rand() * 14);
  lines.push(`        uint256 acc = ${index} + amount;`);
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.18) {
      lines.push(`        if (acc > ${(i + 1) * 17}) {`);
      lines.push(`            acc -= ${i + 3};`);
      lines.push('        } else {');
      lines.push(`            acc += ${i + 5};`);
      lines.push('        }');
    } else if (r < 0.3) {
      lines.push(`        for (uint256 i${i} = 0; i${i} < ${2 + (i % 5)}; ++i${i}) {`);
      lines.push(`            acc = acc * 3 + i${i};`);
      lines.push('        }');
    } else if (r < 0.42 && peers.length > 0) {
      const peer = pick(rand, peers);
      lines.push(`        acc += ${peer.iface}(${peer.field}).${peer.method}(acc);`);
    } else if (r < 0.5) {
      lines.push('        unchecked {');
      lines.push(`            acc += ${i + 1};`);
      lines.push('        }');
    } else if (r < 0.58) {
      lines.push(`        require(acc != ${i * 13}, "bad state");`);
    } else if (r < 0.66) {
      lines.push(`        emit ${name[0].toUpperCase()}${name.slice(1)}Step(msg.sender, acc);`);
    } else if (r < 0.72) {
      lines.push(`        if (acc == 0) revert Rejected(${i});`);
    } else if (r < 0.8) {
      lines.push(`        balances[msg.sender] += acc % ${7 + i};`);
    } else if (r < 0.88) {
      lines.push(`        acc = _helper${index % 4}(acc);`);
    } else {
      lines.push(`        total = total + acc / ${2 + (i % 6)};`);
    }
  }
  lines.push('        return acc;');
  return lines.join('\n');
}

function contractSource(rand, idx, imports, peers) {
  const mod = MODULES[idx % MODULES.length];
  const name = `${mod[0].toUpperCase()}${mod.slice(1)}${idx}`;
  const base = idx > 3 && rand() < 0.55 ? `Base${idx % 7}` : null;

  const out = [];
  out.push('// SPDX-License-Identifier: MIT');
  out.push('pragma solidity ^0.8.20;');
  out.push('');
  for (const imp of imports) out.push(`import {${imp.symbol}} from "${imp.path}";`);
  if (imports.length) out.push('');

  out.push(`interface I${name} {`);
  out.push('    function probe(uint256 amount) external returns (uint256);');
  out.push('}');
  out.push('');

  out.push(`library ${name}Math {`);
  out.push('    function clamp(uint256 v, uint256 hi) internal pure returns (uint256) {');
  out.push('        return v > hi ? hi : v;');
  out.push('    }');
  out.push('}');
  out.push('');

  out.push(`contract ${name}${base ? ` is ${base}` : ''} {`);
  out.push(`    using ${name}Math for uint256;`);
  out.push('');
  out.push('    error Rejected(uint256 code);');
  out.push('');
  out.push('    uint256 public total;');
  out.push('    address public owner;');
  out.push('    mapping(address => uint256) public balances;');
  for (const peer of peers) out.push(`    address public ${peer.field};`);
  out.push('');

  const methods = [];
  const count = 4 + Math.floor(rand() * 7);
  for (let i = 0; i < count; i++) methods.push(`${pick(rand, VERBS)}${i}`);

  for (const m of methods) {
    out.push(`    event ${m[0].toUpperCase()}${m.slice(1)}Step(address indexed who, uint256 acc);`);
  }
  out.push('');

  out.push('    modifier onlyOwner() {');
  out.push('        require(msg.sender == owner, "not owner");');
  out.push('        _;');
  out.push('    }');
  out.push('');
  out.push('    constructor() {');
  out.push('        owner = msg.sender;');
  out.push('    }');
  out.push('');

  for (let h = 0; h < 4; h++) {
    out.push(`    function _helper${h}(uint256 v) internal pure returns (uint256) {`);
    out.push(`        return v.clamp(${1000 * (h + 1)});`);
    out.push('    }');
    out.push('');
  }

  methods.forEach((m, i) => {
    const vis = i % 3 === 0 ? 'external' : i % 3 === 1 ? 'public' : 'internal';
    const guard = i % 4 === 0 ? ' onlyOwner' : '';
    out.push(`    function ${m}(uint256 amount) ${vis}${guard} returns (uint256) {`);
    out.push(body(rand, m, idx + i, peers));
    out.push('    }');
    out.push('');
  });

  out.push('    function probe(uint256 amount) external returns (uint256) {');
  out.push(`        return ${methods[0]}(amount);`);
  out.push('    }');
  out.push('}');
  out.push('');
  return { name, source: out.join('\n') };
}

function baseSource(i) {
  return [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.20;',
    '',
    `abstract contract Base${i} {`,
    '    uint256 internal _nonce;',
    '',
    `    function tag${i}() public view virtual returns (uint256) {`,
    `        return _nonce + ${i};`,
    '    }',
    '}',
    '',
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const slocTarget = Number(argv[argv.indexOf('--sloc') + 1]) || 200_000;
  const outDir = path.join(
    HERE,
    argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'generated',
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'src', 'base'), { recursive: true });

  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(outDir, 'src', 'base', `Base${i}.sol`), baseSource(i));
  }

  const rand = rng(0xa10a9); // fixed seed — the fixture must be byte-identical everywhere
  let sloc = 7 * 11;
  let idx = 0;
  const written = [];

  while (sloc < slocTarget) {
    const dir = `m${idx % 12}`;
    const peers = written.slice(-3).map((w, k) => ({
      iface: `I${w.name}`,
      field: `peer${k}`,
      method: 'probe',
    }));
    const imports = [];
    if (idx > 3) {
      imports.push({ symbol: `Base${idx % 7}`, path: `../base/Base${idx % 7}.sol` });
    }
    written.slice(-3).forEach((w) => {
      imports.push({ symbol: `I${w.name}`, path: `../${w.dir}/${w.name}.sol` });
    });

    const { name, source } = contractSource(rand, idx, imports, peers);
    fs.mkdirSync(path.join(outDir, 'src', dir), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'src', dir, `${name}.sol`), source);
    written.push({ name, dir });
    sloc += source.split('\n').filter((l) => l.trim() !== '').length;
    idx++;
  }

  fs.writeFileSync(
    path.join(outDir, 'foundry.toml'),
    '[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\n',
  );

  const files = idx + 7;
  process.stdout.write(
    `fixtures/large: ${files} files, ${idx * 3 + 7} contracts, ~${sloc.toLocaleString()} SLOC -> ${path.relative(process.cwd(), outDir)}\n`,
  );
}

main();
