// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import "./Interfaces/IOracle.sol";

/**
 * @dev The following is a sample Oracle Implementation for a Tracer Oracle.
 *      Each Tracer may have a different oracle implementation, as long as it conforms
 *      to the IOracle interface and has been approved by the community.
 *      Chainlink reference data contracts currently conform to the IOracle spec and as
 *      such can be used as the oracle implementation.
 */
contract Oracle is IOracle {

    int256 public price = 100000000;
    uint8 public override decimals = 8; // default of 8 decimals for USD price feeds in the Chainlink ecosystem

    function latestAnswer() external override view returns (int256) {
        return price;
    }

    function isStale() external override view returns (bool) {
        return false;
    }

    function setPrice(int256 _price) public {
        price = _price;
    }

    function setDecimals(uint8 _decimals) external override {
        decimals = _decimals;
    }
}
