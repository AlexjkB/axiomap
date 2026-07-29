// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFactory, IPair} from "./interfaces/IAmm.sol";
import {AmmMath} from "./libraries/AmmMath.sol";
import {Pair} from "./Pair.sol";

contract Factory is IFactory {
    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();
    error Forbidden();

    address public feeSetter;
    mapping(address => mapping(address => address)) public pairs;
    address[] public allPairs;

    constructor(address feeSetter_) {
        feeSetter = feeSetter_;
    }

    function getPair(address tokenA, address tokenB) external view override returns (address) {
        return pairs[tokenA][tokenB];
    }

    /// @notice `create2` with a deterministic salt — the `creates` edge.
    function createPair(address tokenA, address tokenB) external override returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = AmmMath.sortTokens(tokenA, tokenB);
        if (token0 == address(0)) revert ZeroAddress();
        if (pairs[token0][token1] != address(0)) revert PairExists();

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new Pair{salt: salt}());
        IPair(pair).initialize(token0, token1);

        pairs[token0][token1] = pair;
        pairs[token1][token0] = pair;
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair);
    }

    function setFeeSetter(address feeSetter_) external {
        if (msg.sender != feeSetter) revert Forbidden();
        feeSetter = feeSetter_;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }
}
