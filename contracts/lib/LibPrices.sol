//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import "./LibMath.sol";
import "./LibBalances.sol";
import "prb-math/contracts/PRBMathUD60x18.sol";
import "prb-math/contracts/PRBMathSD59x18.sol";

library Prices {
    using LibMath for uint256;

    struct FundingRateInstant {
        uint256 timestamp;
        int256 fundingRate;
        int256 cumulativeFundingRate;
    }

    struct PriceInstant {
        uint256 cumulativePrice;
        uint256 trades;
    }

    struct TWAP {
        uint256 underlying;
        uint256 derivative;
    }

    function fairPrice(uint256 oraclePrice, int256 _timeValue)
        public
        pure
        returns (uint256)
    {
        return uint256(LibMath.abs(oraclePrice.toInt256() - _timeValue));
    }

    function timeValue(uint256 averageTracerPrice, uint256 averageOraclePrice)
        public
        pure
        returns (int256)
    {
        return int256((averageTracerPrice - averageOraclePrice) / 90);
    }

    function averagePrice(PriceInstant memory price)
        public
        pure
        returns (uint256)
    {
        if (price.trades == 0) {
            return 0;
        }
        return price.cumulativePrice / price.trades;
    }

    function averagePriceForPeriod(PriceInstant[24] memory prices)
        public
        pure
        returns (uint256)
    {
        uint256 n = prices.length <= 24 ? prices.length : 24;
        uint256[] memory averagePrices = new uint256[](24);

        for (uint256 i = 0; i < n; i++) {
            PriceInstant memory currPrice = prices[i];
            averagePrices[i] = averagePrice(currPrice);
        }

        return LibMath.mean(averagePrices);
    }

    function globalLeverage(
        uint256 _globalLeverage,
        uint256 oldLeverage,
        uint256 newLeverage
    ) public pure returns (uint256) {
        bool leverageHasIncreased = newLeverage > oldLeverage;

        if (leverageHasIncreased) {
            return _globalLeverage + (newLeverage - oldLeverage);
        } else {
            return _globalLeverage - (newLeverage - oldLeverage);
        }
    }

    /**
     * @notice calculates an 8 hour TWAP starting at the hour index amd moving
     * backwards in time.
     * @param hour the 24 hour index to start at
     * @param tracerPrices the average hourly prices of the derivative over the last
     * 24 hours
     * @param oraclePrices the average hourly prices of the oracle over the last
     * 24 hours
     */
    function calculateTWAP(
        uint256 hour,
        PriceInstant[24] memory tracerPrices,
        PriceInstant[24] memory oraclePrices
    ) public pure returns (TWAP memory) {
        uint256 instantDerivative = 0;
        uint256 cumulativeDerivative = 0;
        uint256 instantUnderlying = 0;
        uint256 cumulativeUnderlying = 0;

        for (uint256 i = 0; i < 8; i++) {
            uint256 currTimeWeight = 8 - i;
            // if hour < i loop back towards 0 from 23.
            // otherwise move from hour towards 0
            uint256 j = hour < i ? 23 - i + hour : hour - i;

            uint256 currDerivativePrice = averagePrice(tracerPrices[j]);
            uint256 currUnderlyingPrice = averagePrice(oraclePrices[j]);

            if (currDerivativePrice > 0) {
                instantDerivative += currTimeWeight;
                cumulativeDerivative += currTimeWeight * currDerivativePrice;
            }

            if (currUnderlyingPrice > 0) {
                instantUnderlying += currTimeWeight;
                cumulativeUnderlying += currTimeWeight * currUnderlyingPrice;
            }

            if (instantDerivative == 0) {
                return TWAP(0, 0);
            } else {
                return
                    TWAP(
                        PRBMathUD60x18.div(
                            cumulativeUnderlying,
                            instantUnderlying
                        ),
                        PRBMathUD60x18.div(
                            cumulativeDerivative,
                            instantDerivative
                        )
                    );
            }
        }
    }

    function applyFunding(
        Balances.Position memory position,
        FundingRateInstant memory globalRate,
        FundingRateInstant memory userRate
    ) internal pure returns (Balances.Position memory) {
        return
            Balances.Position(
                position.quote -
                    PRBMathSD59x18.mul(
                        globalRate.fundingRate - userRate.fundingRate,
                        position.base
                    ),
                position.base
            );
    }

    function applyInsurance(
        Balances.Position memory userPosition,
        Balances.Position memory insurancePosition,
        FundingRateInstant memory globalRate,
        FundingRateInstant memory userRate,
        uint256 totalLeveragedValue
    )
        internal
        pure
        returns (Balances.Position memory, Balances.Position memory)
    {
        int256 insuranceDelta =
            PRBMathSD59x18.mul(
                globalRate.fundingRate - userRate.fundingRate,
                int256(totalLeveragedValue)
            );

        if (insuranceDelta > 0) {
            Balances.Position memory newUserPos =
                Balances.Position(
                    userPosition.quote - insuranceDelta,
                    userPosition.base
                );

            Balances.Position memory newInsurancePos =
                Balances.Position(
                    insurancePosition.quote + insuranceDelta,
                    insurancePosition.base
                );

            return (newUserPos, newInsurancePos);
        } else {
            return (userPosition, insurancePosition);
        }
    }
}
