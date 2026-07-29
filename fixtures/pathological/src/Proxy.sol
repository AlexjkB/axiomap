// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Storage layout: slot 0 = implementation, slot 1 = admin.
contract Proxy {
    address public implementation;
    address public admin;

    constructor(address impl) {
        implementation = impl;
        admin = msg.sender;
    }

    fallback() external payable {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}

    function upgradeTo(address impl) external {
        require(msg.sender == admin, "not admin");
        implementation = impl;
    }
}

/// @notice DELIBERATE STORAGE COLLISION. Slot 0 here is `totalSupply`, but the
/// proxy's slot 0 is `implementation`. Any delegatecall into this contract
/// overwrites the implementation pointer. Seam for the Tier 1 proxy analysis
/// in §16 — the fixture exists now so the analysis has something to find later.
contract Implementation {
    uint256 public totalSupply;
    mapping(address => uint256) public balances;

    function mint(uint256 amount) external {
        totalSupply += amount;
        balances[msg.sender] += amount;
    }
}
