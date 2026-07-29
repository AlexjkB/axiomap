import { describe, expect, it } from 'vitest';

import { classifyPragma, findSolidityPragma } from '../src/symbols/version.js';

describe('classifyPragma', () => {
  it('treats the tested band as supported', () => {
    for (const raw of [
      'pragma solidity ^0.8.20;',
      'pragma solidity 0.8.28;',
      'pragma solidity >=0.8.0 <0.9.0;',
      'pragma solidity ~0.8.4;',
    ]) {
      expect(classifyPragma(raw).support).toBe('supported');
    }
  });

  it('treats 0.5–0.7 as best-effort, not unsupported', () => {
    // §4: Uniswap V2 and Compound V2 forks live here, and in a fork that *is*
    // the code under audit. Hard-failing would make Axiomap useless for a
    // whole category of engagement.
    for (const raw of [
      'pragma solidity =0.5.16;',
      'pragma solidity ^0.6.12;',
      'pragma solidity ^0.7.6;',
      'pragma solidity >=0.5.0 <0.8.0;',
    ]) {
      expect(classifyPragma(raw).support).toBe('best-effort');
    }
  });

  it('refuses below the 0.5 hard floor', () => {
    for (const raw of ['pragma solidity ^0.4.24;', 'pragma solidity 0.4.11;']) {
      expect(classifyPragma(raw).support).toBe('unsupported');
    }
  });

  it('classifies an open-ended lower bound by the newest compiler it admits', () => {
    // OpenZeppelin's interfaces say this. Reading it as "0.4 code" would mark
    // most of a healthy dependency tree unsupported; solc compiles them at 0.8
    // and so does Axiomap.
    const result = classifyPragma('pragma solidity >=0.4.16;');
    expect(result.support).toBe('supported');
    expect(result.effective).toBeNull();
  });

  it('reads caret on a 0.x version as pinning the minor', () => {
    // `^0.8.20` means `>=0.8.20 <0.9.0`, not "any 0.x".
    expect(classifyPragma('pragma solidity ^0.8.20;').effective).toEqual([0, 8]);
    expect(classifyPragma('pragma solidity ^0.6.0;').effective).toEqual([0, 6]);
  });

  it('handles an exclusive upper bound on a .0 patch', () => {
    // `<0.8.0` admits 0.7.x at most; `<0.8.5` still admits 0.8.
    expect(classifyPragma('pragma solidity >=0.7.0 <0.8.0;').effective).toEqual([0, 7]);
    expect(classifyPragma('pragma solidity >=0.8.0 <0.8.5;').effective).toEqual([0, 8]);
  });

  it('reports a missing or unreadable pragma as unknown', () => {
    expect(classifyPragma(null).support).toBe('unknown');
    expect(classifyPragma('pragma solidity;').support).toBe('unknown');
  });
});

describe('findSolidityPragma', () => {
  it('ignores non-solidity pragmas', () => {
    expect(
      findSolidityPragma([
        { raw: 'pragma abicoder v2;' },
        { raw: 'pragma solidity ^0.8.20;' },
      ]),
    ).toBe('pragma solidity ^0.8.20;');
  });

  it('returns null when there is none', () => {
    expect(findSolidityPragma([{ raw: 'pragma experimental ABIEncoderV2;' }])).toBeNull();
  });
});
