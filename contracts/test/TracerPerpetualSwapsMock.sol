// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.4;

import "../lib/LibMath.sol";
import {Balances} from "../lib/LibBalances.sol";
import "../TracerPerpetualSwaps.sol";

contract TracerPerpetualSwapsMock is TracerPerpetualSwaps {
    using LibMath for uint256;
    using LibMath for int256;

    constructor(
        bytes32 _marketId,
        address _tracerQuoteToken,
        address _gasPriceOracle,
        uint256 _maxLeverage,
        uint256 _fundingRateSensitivity,
        uint256 _feeRate,
        address _feeReceiver,
        uint256 _deleveragingCliff,
        uint256 _lowestMaxLeverage,
        uint256 _insurancePoolSwitchStage,
        uint256 _liquidationGasCost
    )
        TracerPerpetualSwaps(
            _marketId,
            _tracerQuoteToken,
            _gasPriceOracle,
            _maxLeverage,
            _fundingRateSensitivity,
            _feeRate,
            _feeReceiver,
            _deleveragingCliff,
            _lowestMaxLeverage,
            _insurancePoolSwitchStage,
            _liquidationGasCost
        )
    {}

    /**
     * @notice Transfers quote from the sender to a specified account balance
     * @dev Updates TVL so that it can be withdrawn successfully
     * @param account Address of account
     * @param amount Amount of quote tokens to add to position
     */
    function depositToAccount(address account, uint256 amount) external {
        uint256 rawTokenAmount = uint256(Balances.wadToToken(quoteTokenDecimals, amount).toInt256());
        // converted wad amount used to remove dust
        int256 convertedWadAmount = Balances.tokenToWad(quoteTokenDecimals, rawTokenAmount);

        // update user state
        Balances.Account storage userBalance = balances[account];
        userBalance.position.quote = userBalance.position.quote + convertedWadAmount;
        _updateAccountLeverage(msg.sender);

        // update market TVL
        tvl = tvl + uint256(convertedWadAmount);

        require(
            IERC20(tracerQuoteToken).transferFrom(msg.sender, address(this), rawTokenAmount),
            "TCR: Transfer failed"
        );
    }

    /**
     * @notice Set the leveraged notional value for the market
     * @param value New leveraged notional value
     */
    function setLeveragedNotionalValue(uint256 value) external {
        leveragedNotionalValue = value;
    }
}
