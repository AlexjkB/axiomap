// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The other `Duplicate`. Same name, different file, different members.
contract Duplicate {
    uint256 public which = 2;
    address public owner;

    function whoAmI() external pure returns (string memory) {
        return "dup-b";
    }

    function claim() external {
        owner = msg.sender;
    }
}
