// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Syntactically valid, semantically rejected by solc. The tolerant
/// parser must produce a complete AST for this file; only the semantic tier
/// may ever notice something is wrong. This is decision #1 in one file.
contract DoesNotCompile {
    uint256 public count;

    /// @dev `undeclaredHelper` does not exist anywhere in the project.
    function increment() external {
        count += undeclaredHelper();
    }

    /// @dev Type error: assigning a string to a uint256.
    function broken() external {
        count = "not a number";
    }

    /// @dev Wrong argument count against a real function.
    function alsoBroken() external view returns (uint256) {
        return identity(1, 2, 3);
    }

    function identity(uint256 x) internal pure returns (uint256) {
        return x;
    }

    /// @dev Missing return on a declared return type.
    function noReturn() external pure returns (uint256) {}
}
