// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPair, IERC20Minimal} from "./interfaces/IAmm.sol";
import {AmmMath, SafeTransfer} from "./libraries/AmmMath.sol";

/// @notice Minimal LP share accounting. Kept in the Pair to stay under 300 lines.
abstract contract Shares {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function _mintShares(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burnShares(address from, uint256 value) internal {
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }
}

contract Pair is IPair, Shares {
    using AmmMath for uint256;
    using SafeTransfer for address;

    error Forbidden();
    error Locked();
    error InsufficientLiquidityMinted();
    error InsufficientOutputAmount();
    error KInvariant();

    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    address public factory;
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;

    uint256 private unlocked = 1;

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    function initialize(address token0_, address token1_) external override {
        if (msg.sender != factory) revert Forbidden();
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() public view override returns (uint112, uint112) {
        return (reserve0, reserve1);
    }

    function mint(address to) external override lock returns (uint256 liquidity) {
        (uint112 r0, uint112 r1) = getReserves();
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - r0;
        uint256 amount1 = balance1 - r1;

        if (totalSupply == 0) {
            liquidity = AmmMath.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mintShares(address(0), MINIMUM_LIQUIDITY);
        } else {
            liquidity = AmmMath.min(
                (amount0 * totalSupply) / r0,
                (amount1 * totalSupply) / r1
            );
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();

        _mintShares(to, liquidity);
        _update(balance0, balance1);
        emit Mint(msg.sender, amount0, amount1);
    }

    function burn(address to) external override lock returns (uint256 amount0, uint256 amount1) {
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        amount0 = (liquidity * balance0) / totalSupply;
        amount1 = (liquidity * balance1) / totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientOutputAmount();

        _burnShares(address(this), liquidity);
        token0.safeTransfer(to, amount0);
        token1.safeTransfer(to, amount1);

        _update(
            IERC20Minimal(token0).balanceOf(address(this)),
            IERC20Minimal(token1).balanceOf(address(this))
        );
        emit Burn(msg.sender, amount0, amount1, to);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to) external override lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 r0, uint112 r1) = getReserves();

        if (amount0Out > 0) token0.safeTransfer(to, amount0Out);
        if (amount1Out > 0) token1.safeTransfer(to, amount1Out);

        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));

        uint256 amount0In = balance0 > r0 - amount0Out ? balance0 - (r0 - amount0Out) : 0;
        uint256 amount1In = balance1 > r1 - amount1Out ? balance1 - (r1 - amount1Out) : 0;

        uint256 adjusted0 = balance0 * 1000 - amount0In * 3;
        uint256 adjusted1 = balance1 * 1000 - amount1In * 3;
        if (adjusted0 * adjusted1 < uint256(r0) * uint256(r1) * 1000 ** 2) revert KInvariant();

        _update(balance0, balance1);
        emit Swap(msg.sender, amount0In + amount1In, amount0Out + amount1Out, to);
    }

    function _update(uint256 balance0, uint256 balance1) private {
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        emit Sync(reserve0, reserve1);
    }
}
