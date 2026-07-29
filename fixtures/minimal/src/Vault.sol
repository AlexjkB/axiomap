// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Base} from "./Base.sol";
import {IVault} from "./IVault.sol";
import {Token} from "./Token.sol";
import {Deposit, Status, Shares, MathLib, scale, MAX_DEPOSIT} from "./Types.sol";

/// @notice The one contract that exercises every remaining node and edge kind.
contract Vault is Base, IVault {
    using MathLib for uint256;

    /// @notice Contract-level error, target of the `reverts` edge.
    error DepositTooLarge(uint256 amount);

    /// @notice Contract-level event, target of a second `emits` edge.
    event Swept(address indexed to);

    Token public token;
    uint256 internal assets;
    Status public status;
    Deposit[] internal deposits;
    address public implementation;

    constructor(address impl) {
        token = new Token();
        implementation = impl;
        status = Status.Active;
    }

    /// @inheritdoc IVault
    function deposit(uint256 amount) external payable override {
        if (amount > MAX_DEPOSIT) {
            revert DepositTooLarge(amount);
        }
        assets += amount;
        deposits.push(Deposit({owner: msg.sender, amount: amount}));
        token.mint(msg.sender, amount);
        _record(amount);
        emit Deposited(msg.sender, amount);
    }

    /// @inheritdoc IVault
    function totalAssets() external view override returns (uint256) {
        return assets.half() + scale(assets, 2);
    }

    function tag() public view virtual override returns (string memory) {
        return string.concat(super.tag(), "/vault");
    }

    function upgrade(bytes calldata data) external onlyOwner {
        (bool ok,) = implementation.delegatecall(data);
        require(ok, "delegatecall failed");
    }

    function sweep(address payable to) external onlyOwner {
        (bool ok,) = to.call{value: address(this).balance}("");
        require(ok, "sweep failed");
        emit Swept(to);
    }

    function _record(uint256 amount) internal {
        status = amount == 0 ? Status.Idle : Status.Active;
    }
}
