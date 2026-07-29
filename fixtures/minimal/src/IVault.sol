// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The interface Vault implements.
interface IVault {
    event Deposited(address indexed owner, uint256 amount);

    function deposit(uint256 amount) external payable;

    function totalAssets() external view returns (uint256);
}
