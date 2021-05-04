// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import "../Interfaces/IOracle.sol";
import "../lib/LibMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * The Chainlink oracle adapter allows you to wrap a Chainlink oracle feed
 * and ensure that the price is always returned in a wad format. 
 * The upstream feed may be changed (Eg updated to a new Chainlink feed) while
 * keeping price consistency for the actual Tracer perp market.
 */
contract OracleAdapter is IOracle, Ownable {
    using LibMath for uint256;
    IOracle public oracle;
    uint256 private constant MAX_DECIMALS = 18;
    int256 public scaler;

    constructor(address _oracle) {
        oracle = IOracle(_oracle);
        // scaler can be used to keep all feed responses in units of 10^18
        scaler = int256(10**(MAX_DECIMALS - oracle.decimals()));
    }

    /**
     * @notice Gets the latest anwser from the oracle
     * @dev converts the price to a WAD price before returning
     */
    function latestAnswer() external override view returns (int256) {
        return toWad(oracle.latestAnswer());
    }

    function isStale() external override view returns (bool) {
        return oracle.isStale();
    }

    function decimals() external override pure returns(uint8) {
        return uint8(MAX_DECIMALS);
    }

    /**
    * @notice converts a raw value to a WAD value.
    * @dev this allows consistency for oracles used throughout the protocol
    *      and allows oracles to have their decimals changed withou affecting
    *      the market itself
    */
    function toWad(int256 raw) internal view returns(int256) {
        return raw * scaler;
    }

    /**
    * @notice Change the upstream feed address.
    * @dev resets the scalar value to ensure WAD values are always returned 
    */
    function changeUpstreamOracle(address newOracle) external onlyOwner {
        oracle = IOracle(newOracle);
        // reset the scaler for consistency
        scaler = int256(10**(MAX_DECIMALS - oracle.decimals()));
    }
}
