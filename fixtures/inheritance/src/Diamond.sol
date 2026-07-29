// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Classic diamond. C3 linearization of `D` is [D, C, B, A].
/// `D.ping()` walking `super` therefore visits C, then B, then A.
abstract contract A {
    uint256 public trail;

    function ping() public virtual {
        trail = trail * 10 + 1;
    }
}

abstract contract B is A {
    function ping() public virtual override {
        super.ping();
        trail = trail * 10 + 2;
    }
}

abstract contract C is A {
    function ping() public virtual override {
        super.ping();
        trail = trail * 10 + 3;
    }
}

contract D is B, C {
    function ping() public override(B, C) {
        super.ping();
        trail = trail * 10 + 4;
    }
}

/// @notice Same bases, opposite declaration order. Linearization is [E, B, C, A].
/// A resolver that ignores declaration order will get one of these two wrong.
contract E is C, B {
    function ping() public override(B, C) {
        super.ping();
        trail = trail * 10 + 5;
    }
}
