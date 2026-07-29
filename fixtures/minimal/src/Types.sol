// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A user-defined value type. Exactly one in this fixture.
type Shares is uint128;

/// @notice A file-level struct.
struct Deposit {
    address owner;
    uint256 amount;
}

/// @notice A file-level enum.
enum Status {
    Idle,
    Active,
    Paused
}

/// @notice A file-level error.
error NotAuthorized(address caller);

/// @notice A file-level constant.
uint256 constant MAX_DEPOSIT = 1_000_000 ether;

/// @notice A file-level free function.
function scale(uint256 amount, uint256 factor) pure returns (uint256) {
    return amount * factor;
}

/// @notice The library, target of the `using ... for` edge.
library MathLib {
    function half(uint256 value) internal pure returns (uint256) {
        return value / 2;
    }
}
