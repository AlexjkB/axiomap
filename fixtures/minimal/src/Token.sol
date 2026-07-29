// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Target of the `creates` edge and of an external call.
contract Token {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}
