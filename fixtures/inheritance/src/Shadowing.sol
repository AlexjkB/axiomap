// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IGreeter {
    function greet() external view returns (string memory);
}

interface INamed {
    function name() external view returns (string memory);
}

/// @notice Implements two interfaces at once, and leaves one function abstract.
abstract contract Greeter is IGreeter, INamed {
    string internal _greeting = "hello";

    function greet() public view virtual override returns (string memory) {
        return _greeting;
    }

    /// @dev Deliberately unimplemented — Greeter is abstract because of this.
    function name() public view virtual override returns (string memory);
}

/// @notice Overrides an inherited function and declares a member that shadows
/// the base's internal state variable name in a local scope.
contract Politeness is Greeter {
    function name() public pure override returns (string memory) {
        return "Politeness";
    }

    function greet() public view override returns (string memory) {
        string memory _greeting = super.greet();
        return string.concat(_greeting, ", friend");
    }
}

/// @notice Multiple inheritance where only one base declares the function, so
/// `override` needs no explicit base list.
contract Loud is Politeness {
    function greet() public view override returns (string memory) {
        return string.concat(super.greet(), "!");
    }
}
