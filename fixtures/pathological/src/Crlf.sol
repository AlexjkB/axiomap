// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Every line ending in this file is CRLF, and the comment below
/// contains multi-byte characters: ééé 世界 🔥. Both together are the classic
/// source of off-by-N byte offsets that present as misplaced navigation.
contract Crlf {
    uint256 public value;

    /// @dev Café — the offset of `set` must be a BYTE offset, not a character one.
    function set(uint256 v) external {
        value = v;
    }

    function get() external view returns (uint256) {
        return value;
    }
}
