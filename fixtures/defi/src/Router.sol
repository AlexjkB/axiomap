// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFactory, IPair, IERC20Minimal} from "./interfaces/IAmm.sol";
import {AmmMath} from "./libraries/AmmMath.sol";

/// @notice The external entrypoint. Every call from here crosses a trust
/// boundary via an interface, which is the edge kind auditors care about most.
contract Router {
    using AmmMath for uint256;

    error Expired();
    error InsufficientOutput();
    error PairNotFound();

    address public immutable factory;

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    constructor(address factory_) {
        factory = factory_;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 liquidity) {
        address pair = _pairFor(tokenA, tokenB);
        IERC20Minimal(tokenA).transferFrom(msg.sender, pair, amountA);
        IERC20Minimal(tokenB).transferFrom(msg.sender, pair, amountB);
        liquidity = IPair(pair).mint(to);
    }

    function removeLiquidity(address tokenA, address tokenB, address to, uint256 deadline)
        external
        ensure(deadline)
        returns (uint256 amountA, uint256 amountB)
    {
        address pair = _pairFor(tokenA, tokenB);
        (amountA, amountB) = IPair(pair).burn(to);
    }

    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountOut) {
        address pair = _pairFor(tokenIn, tokenOut);
        amountOut = getAmountOut(tokenIn, tokenOut, amountIn);
        if (amountOut < amountOutMin) revert InsufficientOutput();

        IERC20Minimal(tokenIn).transferFrom(msg.sender, pair, amountIn);
        (address token0,) = AmmMath.sortTokens(tokenIn, tokenOut);
        (uint256 amount0Out, uint256 amount1Out) =
            tokenIn == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        IPair(pair).swap(amount0Out, amount1Out, to);
    }

    function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256)
    {
        address pair = _pairFor(tokenIn, tokenOut);
        (uint112 r0, uint112 r1) = IPair(pair).getReserves();
        (address token0,) = AmmMath.sortTokens(tokenIn, tokenOut);
        (uint256 reserveIn, uint256 reserveOut) =
            tokenIn == token0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        return AmmMath.amountOut(amountIn, reserveIn, reserveOut);
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        external
        pure
        returns (uint256)
    {
        return amountA.quote(reserveA, reserveB);
    }

    function _pairFor(address tokenA, address tokenB) internal view returns (address pair) {
        pair = IFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound();
    }
}
