// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;

/// @notice Below the 0.8 support floor but above the 0.5 hard floor (§4).
/// Parsed and graphed, excluded from the resolution score, reported as
/// unsupported in the build summary. Must not cause an exit.
contract Legacy {
    address public owner;
    uint256 public total;

    constructor() public {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function add(uint256 amount) public onlyOwner {
        total += amount;
    }
}
