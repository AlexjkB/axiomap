// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Inline assembly, unchecked blocks, low-level ops.
/// Comment with non-ASCII identifiers on purpose: naïve café — Ω ≈ 世界 — 🜁.
/// Byte offsets after this line differ from character offsets. That is the point.
contract Assembly {
    uint256 public slot0;

    /// @notice `résultat` and `Δ` appear only in comments — Solidity identifiers
    /// are ASCII-only, so a fixture using a non-ASCII one would be testing the
    /// parser's error path rather than its offset arithmetic.
    function readSlot(uint256 slot) external view returns (bytes32 result) {
        assembly {
            result := sload(slot)
        }
    }

    function writeRaw(uint256 slot, bytes32 value) external {
        assembly {
            sstore(slot, value)
        }
    }

    function counted(uint256 n) external pure returns (uint256 total) {
        unchecked {
            for (uint256 i = 0; i < n; ++i) {
                total += i;
            }
        }
    }

    function destroy(address payable to) external {
        selfdestruct(to);
    }

    function codeSize(address target) external view returns (uint256 size) {
        assembly {
            size := extcodesize(target)
        }
    }
}
