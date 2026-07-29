// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IThing {
    function work(uint256 x) external returns (uint256);
}

/// @notice Every call target here is legitimately unresolvable without running
/// the program. The resolver must emit `unresolved`, not a guess.
contract Indirect {
    error Failed(string reason);

    event Result(uint256 value);

    /// @notice Function pointer stored in state.
    function(uint256) internal pure returns (uint256) internal transform;

    address public target;

    function double(uint256 x) internal pure returns (uint256) {
        return x * 2;
    }

    function triple(uint256 x) internal pure returns (uint256) {
        return x * 3;
    }

    function choose(bool useDouble) external {
        transform = useDouble ? double : triple;
    }

    /// @notice Call through a function pointer — target unknowable statically.
    function apply_(uint256 x) external view returns (uint256) {
        return transform(x);
    }

    /// @notice Selector-based dispatch — `unresolved` until §16 lands literal
    /// selector matching.
    function raw(bytes4 selector, uint256 arg) external returns (bytes memory) {
        (bool ok, bytes memory data) = target.call(abi.encodeWithSelector(selector, arg));
        if (!ok) revert Failed("call failed");
        return data;
    }

    /// @notice try/catch over an external call, with three catch clauses.
    function guarded(uint256 x) external returns (uint256 value) {
        try IThing(target).work(x) returns (uint256 v) {
            value = v;
            emit Result(v);
        } catch Error(string memory reason) {
            revert Failed(reason);
        } catch Panic(uint256) {
            value = 0;
        } catch (bytes memory) {
            value = type(uint256).max;
        }
    }

    /// @notice Overload pair. Resolving a bare `pick(0)` needs type inference,
    /// so the resolver must emit `ambiguous` edges to both.
    function pick(uint256 a) public pure returns (uint256) {
        return a;
    }

    function pick(address a) public pure returns (uint256) {
        return uint256(uint160(a));
    }
}
