// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice One of two contracts named `Duplicate`. See ../dup-b/Duplicate.sol.
/// A symbol table keyed by bare name loses one of these.
contract Duplicate {
    uint256 public which = 1;

    function whoAmI() external pure returns (string memory) {
        return "dup-a";
    }
}
