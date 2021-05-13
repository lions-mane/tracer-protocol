//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

interface IPricing {
    function getFundingRate(uint256 index)
        external
        view
        returns (
            uint256,
            uint256,
            int256,
            int256
        );

    function getInsuranceFundingRate(uint256 index)
        external
        view
        returns (
            uint256,
            uint256,
            int256,
            int256
        );

    function currentFundingIndex() external view returns (uint256);

    function fairPrice() external view returns (uint256);

    function timeValue() external view returns (int256);

    function getTWAPs(uint256 currentHour)
        external
        view
        returns (uint256, uint256);

    function get24HourPrices() external view returns (uint256, uint256);

    function getHourlyAvgTracerPrice(uint256 hour)
        external
        view
        returns (uint256);

    function transferOwnership(address newOwner) external;

    function getHourlyAvgOraclePrice(uint256 hour)
        external
        view
        returns (uint256);

    function recordTrade(uint256 tradePrice, uint256 tradeVolume) external;
}
