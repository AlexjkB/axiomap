// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NotAuthorized} from "./Types.sol";

/// @notice Abstract base. Source of the `inherits`, `super` and `modifiedBy` edges.
abstract contract Base {
    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotAuthorized(msg.sender);
        }
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Overridden by Vault, which calls back into it via `super`.
    function tag() public view virtual returns (string memory) {
        return "base";
    }
}
