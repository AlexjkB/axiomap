// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A genuine syntax error, mid-file. Everything before it is valid and
/// must survive; a parser that returns nothing for this file fails Phase 1.
/// The recovery quality on this file is a bake-off criterion.
contract BeforeTheError {
    uint256 public intact;

    function fine() external view returns (uint256) {
        return intact;
    }
}

contract Broken {
    uint256 public alsoIntact;

    function truncated(uint256 a returns (uint256) {
        return a
    }

    function afterTheError() external pure returns (bool) {
        return true;
    }
}

contract AfterTheError {
    function stillHere() external pure returns (uint256) {
        return 42;
    }
}
