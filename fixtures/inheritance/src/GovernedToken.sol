// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice The realistic case: two OpenZeppelin extensions that both override
/// `_update`, so the C3 chain has to be walked through library code resolved by
/// a remapping. This is the fixture's whole point.
contract GovernedToken is ERC20, ERC20Burnable, ERC20Pausable, Ownable2Step {
    constructor(address initialOwner) ERC20("Governed", "GOV") Ownable(initialOwner) {
        _mint(initialOwner, 1_000_000e18);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Must name both bases; both ERC20 and ERC20Pausable define `_update`.
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Pausable)
    {
        super._update(from, to, value);
    }

    /// @dev Ownable2Step overrides Ownable's `_transferOwnership`; this reaches
    /// past one override into the other via `super`.
    function _transferOwnership(address newOwner) internal override(Ownable2Step, Ownable) {
        super._transferOwnership(newOwner);
    }
}
