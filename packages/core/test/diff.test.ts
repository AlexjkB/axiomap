/**
 * The diff engine (§8), unit by unit.
 *
 * Every project here is written inline and is three contracts long, so each
 * assertion has one reason to fail. The end-to-end case — §7's exit criterion,
 * `axiomap diff` between the two `defi/` tags — lives in `packages/cli`, since
 * resolving a git revision is the CLI's job and not `core`'s (§6 keeps core to
 * `fs`).
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  classifyChanges,
  deriveFindings,
  diffGraphs,
  nameSimilarity,
  type AxiomapGraph,
  type ChangeStatus,
  type FindingKind,
} from '../src/index.js';
import { buildTempProject, cleanUpTempProjects } from './temp-project.js';
import { enrichedGraphOf, graphOf } from './graphs.js';

afterAll(cleanUpTempProjects);

async function pair(
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<{ before: AxiomapGraph; after: AxiomapGraph }> {
  const [a, b] = await Promise.all([buildTempProject(before), buildTempProject(after)]);
  return { before: a.graph, after: b.graph };
}

function statusOf(
  diff: ReturnType<typeof classifyChanges>,
  id: string,
): ChangeStatus | undefined {
  return diff.nodes.find((node) => node.id === id)?.status;
}

function findingKinds(diff: ReturnType<typeof diffGraphs>, node: string): FindingKind[] {
  return diff.findings.filter((finding) => finding.node === node).map((finding) => finding.kind);
}

const VAULT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vault {
    uint256 public total;
    address public owner;

    function deposit(uint256 amount) external {
        total += amount;
    }

    function helper(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b + 1;
    }
}
`;

const VAULT_V1 = { 'src/Vault.sol': VAULT_SOURCE };

describe('node matching (§8)', () => {
  it('matches an untouched node by id, and reports it unchanged', async () => {
    const { before, after } = await pair(VAULT_V1, VAULT_V1);
    const diff = classifyChanges(before, after);
    expect(diff.nodeSummary.unchanged).toBe(diff.nodes.length);
    expect(diff.matching.matches.every((match) => match.tier === 'exact')).toBe(true);
  });

  it('matches a renamed function by body hash and calls it renamed', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace('function helper(', 'function combine('),
    });
    const diff = classifyChanges(before, after);
    const id = 'src/Vault.sol:Vault.combine(uint256,uint256)';
    const change = diff.nodes.find((node) => node.id === id);
    expect(change?.status).toBe('renamed');
    expect(change?.match?.tier).toBe('body');
    expect(change?.match?.before).toBe('src/Vault.sol:Vault.helper(uint256,uint256)');
    // The body did not change, so the only differences are the name and the
    // interface hash that carries it.
    expect(change?.changes).toEqual(['interfaceHash', 'name']);
  });

  it('matches a moved function by body hash and calls it moved', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        / {4}function helper[\s\S]*?\n {4}}\n/,
        '',
      ),
      'src/Math.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Math {
    function helper(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b + 1;
    }
}
`,
    });
    const diff = classifyChanges(before, after);
    const change = diff.nodes.find((node) => node.id === 'src/Math.sol:Math.helper(uint256,uint256)');
    expect(change?.status).toBe('moved');
    expect(change?.match?.tier).toBe('body');
    expect(change?.changes).toEqual(['file', 'scope']);
  });

  it('never matches two bodyless declarations by hash', async () => {
    // Ten of `defi/`'s functions are interface declarations with an empty body
    // hash. Tier 2 must skip them, or they are all mutual rename candidates.
    const { before, after } = await pair(
      {
        'src/I.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface I {
    function alpha() external;
    function beta() external;
}
`,
      },
      {
        'src/I.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface I {
    function alpha() external;
    function gamma() external;
}
`,
      },
    );
    const diff = classifyChanges(before, after);
    expect(statusOf(diff, 'src/I.sol:I.gamma()')).toBe('added');
    expect(statusOf(diff, 'src/I.sol:I.beta()')).toBe('removed');
  });

  it('matches a changed signature by container and name', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE
        .replace('function helper(uint256 a, uint256 b)', 'function helper(uint256 a)')
        .replace('return a + b + 1;', 'return a + 1;'),
    });
    const diff = classifyChanges(before, after);
    const change = diff.nodes.find((node) => node.id === 'src/Vault.sol:Vault.helper(uint256)');
    expect(change?.match?.tier).toBe('signature');
    expect(change?.status).toBe('modified');
    expect(change?.changes).toContain('params');
  });

  it('leaves an overload set alone rather than guessing which is which', async () => {
    // Same container, same name, two of each: tier 3 requires uniqueness on
    // both sides, and picking one is the guess §6 forbids.
    const overloadsV1 = {
      'src/O.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract O {
    function f(uint256 a) internal pure returns (uint256) { return a + 1; }
    function f(address a) internal pure returns (address) { return a; }
    function g() internal pure returns (uint256) { return 7; }
}
`,
    };
    const overloadsV2 = {
      'src/O.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract O {
    function f(uint64 a) internal pure returns (uint64) { return a + 2; }
    function f(bytes32 a) internal pure returns (bytes32) { return a >> 1; }
    function g() internal pure returns (uint256) { return 7; }
}
`,
    };
    const { before: a, after: b } = await pair(overloadsV1, overloadsV2);
    const diff = classifyChanges(a, b);
    // `g` is untouched and matches exactly; neither `f` matches anything, so
    // both sides are reported as they are rather than paired by ordering.
    expect(statusOf(diff, 'src/O.sol:O.g()')).toBe('unchanged');
    expect(statusOf(diff, 'src/O.sol:O.f(uint64)')).toBe('added');
    expect(statusOf(diff, 'src/O.sol:O.f(bytes32)')).toBe('added');
    expect(statusOf(diff, 'src/O.sol:O.f(uint256)')).toBe('removed');
    expect(statusOf(diff, 'src/O.sol:O.f(address)')).toBe('removed');
  });

  it('reports a probable rename with a confidence, and not the wrong candidate', async () => {
    const routerV1 = {
      'src/R.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract R {
    uint256 public total;
    function getAmountOut(uint256 a, uint256 b) public view returns (uint256) {
        return a + b + total;
    }
    function caller(uint256 a) external view returns (uint256) {
        return getAmountOut(a, 1);
    }
}
`,
    };
    const routerV2 = {
      'src/R.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract R {
    uint256 public total;
    function amountOutFor(uint256 a, uint256 b) public view returns (uint256) {
        return a + b + total + 1;
    }
    function unrelated(uint256 a, uint256 b) public view returns (uint256) {
        return a * b;
    }
    function caller(uint256 a) external view returns (uint256) {
        return amountOutFor(a, 1);
    }
}
`,
    };
    const { before: a, after: b } = await pair(routerV1, routerV2);
    const diff = classifyChanges(a, b);
    const change = diff.nodes.find((node) => node.id === 'src/R.sol:R.amountOutFor(uint256,uint256)');
    expect(change?.status).toBe('renamed');
    expect(change?.match?.tier).toBe('fuzzy');
    expect(change?.match?.confidence).toBeGreaterThan(0.55);
    expect(change?.match?.before).toBe('src/R.sol:R.getAmountOut(uint256,uint256)');
    // `unrelated` has the same parameter types and returns and is in the same
    // contract. It is still an addition, because the name and the
    // call-neighbourhood say so.
    expect(statusOf(diff, 'src/R.sol:R.unrelated(uint256,uint256)')).toBe('added');
  });

  it('reports nothing rather than a bad guess when the threshold is raised', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE
        .replace('function helper(', 'function combine(')
        .replace('return a + b + 1;', 'return a * b;'),
    });
    const strict = classifyChanges(before, after, { fuzzyThreshold: 1.01 });
    expect(statusOf(strict, 'src/Vault.sol:Vault.combine(uint256,uint256)')).toBe('added');
    expect(statusOf(strict, 'src/Vault.sol:Vault.helper(uint256,uint256)')).toBe('removed');
  });

  it('scores name similarity as a bigram Dice coefficient', () => {
    expect(nameSimilarity('deposit', 'deposit')).toBe(1);
    expect(nameSimilarity('getAmountOut', 'amountOutFor')).toBeGreaterThan(0.5);
    expect(nameSimilarity('deposit', 'sweep')).toBeLessThanOrEqual(0.2);
    expect(nameSimilarity('a', 'b')).toBe(0);
  });
});

describe('change classification (§8)', () => {
  it('ignores source positions', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        'contract Vault {',
        '// a comment that pushes everything down\n// and another\ncontract Vault {',
      ),
    });
    const diff = classifyChanges(before, after);
    expect(diff.nodeSummary.unchanged).toBe(diff.nodes.length);
  });

  it('ignores a NatSpec edit, because the body hash does', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        '        total += amount;',
        '        // recount the total\n        total += amount;',
      ),
    });
    const diff = classifyChanges(before, after);
    expect(statusOf(diff, 'src/Vault.sol:Vault.deposit(uint256)')).toBe('unchanged');
  });

  it('projects edge endpoints through the matching, so a rename is not a churn of edges', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace('function helper(', 'function combine('),
    });
    const diff = classifyChanges(before, after);
    expect(diff.edgeSummary.added).toBe(0);
    expect(diff.edgeSummary.removed).toBe(0);
    expect(diff.edgeSummary.modified).toBe(0);
  });

  it('is blind to the semantic tier: the same revision at both tiers diffs to nothing', async () => {
    // §8's premise is that a historical revision cannot be compiled, so the
    // normal diff is one side with artifacts and one without. `defi/` ships
    // build-info, which makes it the one fixture that can prove this.
    const heuristic = await graphOf('defi');
    const semantic = await enrichedGraphOf('defi');
    expect(heuristic.file.mode).toBe('heuristic');
    expect(semantic.file.mode).toBe('full');

    const diff = diffGraphs(heuristic.graph, semantic.graph);
    expect(diff.nodes.filter((node) => node.status !== 'unchanged')).toEqual([]);
    expect(diff.edges.filter((edge) => edge.status !== 'unchanged')).toEqual([]);
    expect(diff.findings).toEqual([]);
  });
});

describe('derived findings (§8)', () => {
  it('finds a new external entrypoint and says whether it is guarded', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        '    function helper(',
        `    function drain(address to) external {
        total = 0;
    }

    function helper(`,
      ),
    });
    const diff = diffGraphs(before, after);
    const finding = diff.findings.find((f) => f.kind === 'new-external-entrypoint');
    expect(finding?.node).toBe('src/Vault.sol:Vault.drain(address)');
    expect(finding?.message).toContain('no recognised access control');
    expect(finding?.evidence).toBe('direct');
  });

  it('finds an access-control modifier removed from a state-mutating function', async () => {
    const guarded = {
      'src/Vault.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Vault {
    uint256 public total;
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner); _; }
    function set(uint256 v) external onlyOwner { total = v; }
}
`,
    };
    const { before, after } = await pair(guarded, {
      'src/Vault.sol': guarded['src/Vault.sol'].replace(' external onlyOwner ', ' external '),
    });
    const diff = diffGraphs(before, after);
    expect(findingKinds(diff, 'src/Vault.sol:Vault.set(uint256)')).toContain(
      'access-control-weakened',
    );
    const finding = diff.findings.find((f) => f.kind === 'access-control-weakened');
    expect(finding?.severity).toBe('high');
    expect(finding?.message).toContain('lost onlyOwner');
  });

  it('finds a new external call in a previously self-contained function', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        '        total += amount;',
        '        total += amount;\n        IToken(owner).ping();',
      ),
      'src/IToken.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IToken { function ping() external; }
`,
    });
    const diff = diffGraphs(before, after);
    expect(findingKinds(diff, 'src/Vault.sol:Vault.deposit(uint256)')).toContain(
      'new-external-call',
    );
  });

  it('finds a function that became payable', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        'function deposit(uint256 amount) external {',
        'function deposit(uint256 amount) external payable {',
      ),
    });
    const diff = diffGraphs(before, after);
    expect(findingKinds(diff, 'src/Vault.sol:Vault.deposit(uint256)')).toContain('became-payable');
  });

  it('finds a state variable inserted before another, and reports the whole layout', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        '    uint256 public total;',
        '    uint256 public version;\n    uint256 public total;',
      ),
    });
    const diff = diffGraphs(before, after);
    const finding = diff.findings.find((f) => f.kind === 'storage-layout-changed');
    expect(finding?.node).toBe('src/Vault.sol:Vault');
    expect(finding?.message).toContain('[total, owner] → [version, total, owner]');
  });

  it('does not call a new constant a layout change', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        '    uint256 public total;',
        '    uint256 public constant CAP = 1;\n    uint256 public total;',
      ),
    });
    const diff = diffGraphs(before, after);
    expect(diff.findings.filter((f) => f.kind === 'storage-layout-changed')).toEqual([]);
  });

  it('finds a new dangerous op', async () => {
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        '        total += amount;',
        '        (bool ok,) = owner.delegatecall("");\n        require(ok);\n        total += amount;',
      ),
    });
    const diff = diffGraphs(before, after);
    const kinds = findingKinds(diff, 'src/Vault.sol:Vault.deposit(uint256)');
    expect(kinds).toContain('new-dangerous-op');
    expect(diff.findings.filter((f) => f.kind === 'new-dangerous-op').map((f) => f.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('hasDelegatecall')]),
    );
  });

  it('labels a reachability finding a consequence when the node itself did not change', async () => {
    // §10's Phase 4 fields are transitive. `helper` is untouched; it became
    // reachable because `deposit` started calling it.
    const { before, after } = await pair(VAULT_V1, {
      'src/Vault.sol': VAULT_SOURCE.replace(
        '        total += amount;',
        '        total += helper(amount, 1);',
      ),
    });
    const diff = diffGraphs(before, after);
    const finding = diff.findings.find((f) => f.kind === 'became-externally-reachable');
    expect(finding?.node).toBe('src/Vault.sol:Vault.helper(uint256,uint256)');
    expect(finding?.evidence).toBe('consequence');
    expect(statusOf(diff, 'src/Vault.sol:Vault.helper(uint256,uint256)')).toBe('unchanged');
  });

  it('produces nothing at all for two identical revisions', async () => {
    const { before, after } = await pair(VAULT_V1, VAULT_V1);
    expect(deriveFindings(classifyChanges(before, after))).toEqual([]);
  });
});
