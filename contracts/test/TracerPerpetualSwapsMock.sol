// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.4;

import "../lib/LibMath.sol";
import {Balances} from "../lib/LibBalances.sol";
import {Types} from "../Interfaces/Types.sol";
import "../Interfaces/IOracle.sol";
import "../Interfaces/IInsurance.sol";
import "../Interfaces/ITracerPerpetualSwaps.sol";
import "../Interfaces/IPricing.sol";
import "../Interfaces/ITrader.sol";
import "../Interfaces/IERC20Details.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "prb-math/contracts/PRBMathSD59x18.sol";
import "prb-math/contracts/PRBMathUD60x18.sol";

contract TracerPerpetualSwapsMock is ITracerPerpetualSwaps, Ownable {
    using LibMath for uint256;
    using LibMath for int256;
    using PRBMathSD59x18 for int256;
    using PRBMathUD60x18 for uint256;

    address public immutable override tracerQuoteToken;
    uint256 public immutable override quoteTokenDecimals;
    bytes32 public immutable override marketId;
    IPricing public pricingContract;
    IInsurance public insuranceContract;
    address public override liquidationContract;
    uint256 public override feeRate;
    uint256 public override fees;
    address public override feeReceiver;

    uint256 private constant MAX_PERCENT = 100e18; // 100% in WAD format, used to check valid parameters.
    uint256 private constant MAX_PERCENT_DECIMAL = 1e18; // 100% expressed as a decimal, in WAD format.

    /* Config variables */
    // The price of gas in gwei
    address public override gasPriceOracle;
    // The maximum ratio of notionalValue to margin
    uint256 public override maxLeverage;
    // WAD value. sensitivity of 1 = 1*10^18
    uint256 public override fundingRateSensitivity;
    // WAD value. The percentage for insurance pool holdings/pool target where deleveraging begins
    uint256 public override deleveragingCliff;
    /* The percentage of insurance holdings to target at which the insurance pool
       funding rate changes, and lowestMaxLeverage is reached */
    uint256 public override insurancePoolSwitchStage;
    // The lowest value that maxLeverage can be, if insurance pool is empty.
    uint256 public override lowestMaxLeverage;
    // The average expected gas cost of liquidations
    uint256 public override liquidationGasCost;

    // Account State Variables
    mapping(address => Balances.Account) public balances;
    uint256 public tvl;
    uint256 public override leveragedNotionalValue;

    // Trading interfaces whitelist
    mapping(address => bool) public override tradingWhitelist;

    event FeeWithdrawn(address indexed receiver, uint256 feeAmount);
    event Deposit(address indexed user, uint256 indexed amount);
    event Withdraw(address indexed user, uint256 indexed amount);
    event Settled(address indexed account, int256 margin);
    event MatchedOrders(
        address indexed long,
        address indexed short,
        uint256 amount,
        uint256 price,
        bytes32 longOrderId,
        bytes32 shortOrderId
    );
    event FailedOrders(
        Perpetuals.OrderMatchingResult status,
        address indexed long,
        address indexed short,
        uint256 amount,
        bytes32 longOrderId,
        bytes32 shortOrderId
    );
    event LiquidationContractUpdated(address newLiquidationAddress);
    event InsuranceContractUpdated(address newInsuranceAddress);
    event PricingContractUpdated(address newPricingAddress);
    event GasOracleUpdated(address newGasOracleAddress);
    event FeeReceiverUpdated(address newReceiverAddresss);
    event FeeRateUpdated(uint256 newFeeRate);
    event MaxLeverageUpdated(uint256 newMaxLeverage);
    event FundingRateSensitivityUpdated(uint256 newFundingRateSensitivity);
    event DeleveragingCliffUpdated(uint256 newDeleveragingCliff);
    event LowestMaxLeverageUpdated(uint256 newLowestMaxLeverage);
    event InsurancePoolSwitchStageUpdated(uint256 newInsurancePoolSwitch);
    event LiquidationGasCostUpdated(uint256 newLiquidationGasCost);
    event WhitelistUpdated(address indexed updatedContract, bool whitelistStatus);

    /**
     * @notice Creates a new tracer market and sets the initial funding rate of the market. Anyone
     *         will be able to purchase and trade tracers after this deployment.
     * @param _marketId the id of the market, given as BASE/QUOTE
     * @param _tracerQuoteToken the address of the token used for margin accounts (i.e. The margin token)
     * @param _gasPriceOracle the address of the contract implementing gas price oracle
     * @param _maxLeverage the max leverage of the market represented as a WAD value.
     * @param _fundingRateSensitivity the affect funding rate changes have on funding paid; u60.18-decimal fixed-point number (WAD value)
     * @param _feeRate the fee taken on trades; decimal percentage converted to WAD value. e.g. 2% fee = 0.02 * 10^18 = 2 * 10^16
     * @param _feeReceiver the address of the person who can withdraw the fees from trades in this market
     * @param _deleveragingCliff The percentage for insurance pool holdings/pool target where deleveraging begins.
     *                           WAD value. e.g. 20% = 20*10^18
     * @param _lowestMaxLeverage The lowest value that maxLeverage can be, if insurance pool is empty.
     * @param _insurancePoolSwitchStage The percentage of insurance holdings to target at which the insurance pool
     *                                  funding rate changes, and lowestMaxLeverage is reached
     * @param _liquidationGasCost The average expected gas cost for liquidations. Used to calculate the maintenance margin
     */
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
    ) Ownable() {
        require(_feeRate <= MAX_PERCENT_DECIMAL, "TCR: Fee rate > 100%");
        require(_deleveragingCliff <= MAX_PERCENT, "TCR: Delev cliff > 100%");
        require(_lowestMaxLeverage <= _maxLeverage, "TCR: Invalid leverage");
        require(_insurancePoolSwitchStage < _deleveragingCliff, "TCR: Invalid switch stage");
        require(_tracerQuoteToken != address(0), "TCR: _tracerQuoteToken = address(0)");
        require(_gasPriceOracle != address(0), "TCR: _gasPriceOracle = address(0)");
        require(_feeReceiver != address(0), "TCR: _feeReceiver = address(0)");
        require(IERC20Details(_tracerQuoteToken).decimals() <= 18, "TCR: Decimals > 18");
        tracerQuoteToken = _tracerQuoteToken;
        quoteTokenDecimals = IERC20Details(_tracerQuoteToken).decimals();
        gasPriceOracle = _gasPriceOracle;
        marketId = _marketId;
        feeRate = _feeRate;
        maxLeverage = _maxLeverage;
        fundingRateSensitivity = _fundingRateSensitivity;
        feeReceiver = _feeReceiver;
        deleveragingCliff = _deleveragingCliff;
        lowestMaxLeverage = _lowestMaxLeverage;
        insurancePoolSwitchStage = _insurancePoolSwitchStage;
        liquidationGasCost = _liquidationGasCost;
    }

    /**
     * @notice Adjust the max leverage as insurance pool slides from 100% of target to 0% of target
     */
    function trueMaxLeverage() public view override returns (uint256) {
        IInsurance insurance = IInsurance(insuranceContract);

        return
            Perpetuals.calculateTrueMaxLeverage(
                insurance.getPoolHoldings(),
                insurance.getPoolTarget(),
                maxLeverage,
                lowestMaxLeverage,
                deleveragingCliff,
                insurancePoolSwitchStage
            );
    }

    /**
     * @notice Allows a user to deposit into their margin account
     * @dev This contract must be an approved spender of the markets quote token on behalf of the depositer.
     * @dev Emits the amount successfully deposited into the account in WAD format with dust removed
     * @param amount The amount of quote tokens to be deposited into the Tracer Market account. This amount
     * should be given in WAD format.
     */
    function deposit(uint256 amount) external override {
        Balances.Account storage userBalance = balances[msg.sender];
        userBalance.position.quote += int256(amount);
    }

    /**
     * @notice Allows a user to withdraw from their margin account
     * @dev Ensures that the users margin percent is valid after withdraw
     * @dev Emits the amount successfully withdrawn in WAD format without dust
     * @param amount The amount of margin tokens to be withdrawn from the tracer market account. This amount
     * should be given in WAD format
     */
    function withdraw(uint256 amount) external override {
        // reduce balance to 0
        Balances.Account storage userBalance = balances[msg.sender];
        userBalance.position.quote = 0;
    }

    /**
     * @notice Attempt to match two orders that exist on-chain against each other
     * @dev Emits a FailedOrders or MatchedOrders event based on whether the
     *      orders were successfully able to be matched
     * @param order1 The first order
     * @param order2 The second order
     * @param fillAmount Amount that the two orders are being filled for
     * @return Whether the two orders were able to be matched successfully
     */
    function matchOrders(
        Perpetuals.Order calldata order1,
        Perpetuals.Order calldata order2,
        uint256 fillAmount
    ) external override onlyWhitelisted returns (bool) {
        require(order1.market == address(this), "TCR: Wrong market");
        // ensure that order 1 is long and order 2 is short
        if (order2.side == Perpetuals.Side.Long) {
            (order1, order2) = (order2, order1);
        }

        bytes32 order1Id = Perpetuals.orderId(order1);
        bytes32 order2Id = Perpetuals.orderId(order2);

        // validate orders can match
        Perpetuals.OrderMatchingResult matchingResult = Perpetuals.canMatch(
            order1,
            ITrader(msg.sender).filled(order1Id),
            order2,
            ITrader(msg.sender).filled(order2Id)
        );
        if (matchingResult != Perpetuals.OrderMatchingResult.VALID) {
            emit FailedOrders(matchingResult, order1.maker, order2.maker, fillAmount, order1Id, order2Id);
            return false;
        }

        uint256 executionPrice = Perpetuals.getExecutionPrice(order1, order2);

        // settle accounts
        // note: this can revert and hence no order events will be emitted
        settle(order1.maker);
        settle(order2.maker);

        (Balances.Position memory newPos1, Balances.Position memory newPos2) = _executeTrade(
            order1,
            order2,
            fillAmount,
            executionPrice
        );

        // check that user margins are valid in outcome state
        matchingResult = _validateMargins(newPos1, order1.maker, newPos2, order2.maker);
        if (matchingResult != Perpetuals.OrderMatchingResult.VALID) {
            emit FailedOrders(matchingResult, order1.maker, order2.maker, fillAmount, order1Id, order2Id);
            return false;
        }

        // update account states
        balances[order1.maker].position = newPos1;
        balances[order2.maker].position = newPos2;

        // update fees
        fees =
            fees +
            // add 2 * fees since getFeeRate returns the fee rate for a single
            // side of the order. Both users were charged fees
            uint256(Balances.getFee(fillAmount, executionPrice, feeRate) * 2);

        // update leverage
        _updateAccountLeverage(order1.maker);
        _updateAccountLeverage(order2.maker);

        // Update internal trade state
        pricingContract.recordTrade(executionPrice, fillAmount);

        emit MatchedOrders(order1.maker, order2.maker, fillAmount, executionPrice, order1Id, order2Id);
        return true;
    }

    /**
     * @notice Updates account states of two accounts given two orders that are being executed
     * @param order1 The first order
     * @param order2 The second order
     * @param fillAmount The amount that the two ordered are being filled for
     * @param executionPrice The execution price of the trades
     * @return The new balances of the two accounts after the trade
     */
    function _executeTrade(
        Perpetuals.Order calldata order1,
        Perpetuals.Order calldata order2,
        uint256 fillAmount,
        uint256 executionPrice
    ) internal view returns (Balances.Position memory, Balances.Position memory) {
        // Retrieve account state
        Balances.Account memory account1 = balances[order1.maker];
        Balances.Account memory account2 = balances[order2.maker];

        // Construct `Trade` types suitable for use with LibBalances
        (Balances.Trade memory trade1, Balances.Trade memory trade2) = (
            Balances.Trade(executionPrice, fillAmount, order1.side),
            Balances.Trade(executionPrice, fillAmount, order2.side)
        );

        // Calculate new account state
        (Balances.Position memory newPos1, Balances.Position memory newPos2) = (
            Balances.applyTrade(account1.position, trade1, feeRate),
            Balances.applyTrade(account2.position, trade2, feeRate)
        );

        // return new account state
        return (newPos1, newPos2);
    }

    /**
     * @notice given the positions of two traders, determine if they have sufficient margin.
     * @return return Perpetuals.OrderMatchingResult.VALID if both positions are valid.
     *         return Perpetuals.OrderMatchingResult.SHORT_MARGIN or LONG_MARGIN if one of the trader positions is invalid.
     */
    function _validateMargins(
        Balances.Position memory newPositionLong,
        address longMaker,
        Balances.Position memory newPositionShort,
        address shortMaker
    ) internal view returns (Perpetuals.OrderMatchingResult) {
        uint256 _fairPrice = pricingContract.fairPrice();
        uint256 _trueMaxLeverage = trueMaxLeverage();
        // check that post-trade positions result in valid margins
        bool longOrderValid = Balances.marginIsValid(
            newPositionLong,
            balances[longMaker].lastUpdatedGasPrice * liquidationGasCost,
            _fairPrice,
            _trueMaxLeverage
        );
        if (!longOrderValid) {
            return Perpetuals.OrderMatchingResult.LONG_MARGIN;
        }

        bool shortOrderValid = Balances.marginIsValid(
            newPositionShort,
            balances[shortMaker].lastUpdatedGasPrice * liquidationGasCost,
            _fairPrice,
            _trueMaxLeverage
        );
        if (!shortOrderValid) {
            return Perpetuals.OrderMatchingResult.SHORT_MARGIN;
        }

        return Perpetuals.OrderMatchingResult.VALID;
    }

    /**
     * @notice Internal function for updating leverage based on a user's position.
     *         Also updates the total leveraged notional value for the tracer market itself.
     * @dev Must be called every time a users balance is udpated.
     */
    function _updateAccountLeverage(address account) internal {
        Balances.Account memory userBalance = balances[account];
        uint256 originalLeverage = userBalance.totalLeveragedValue;
        uint256 newLeverage = Balances.leveragedNotionalValue(userBalance.position, pricingContract.fairPrice());
        balances[account].totalLeveragedValue = newLeverage;

        // Update market leveraged notional value
        _updateTracerLeverage(newLeverage, originalLeverage);
    }

    /**
     * @notice Updates the global leverage value given an accounts new leveraged value and old leveraged value
     * @param accountNewLeveragedNotional The future notional value of the account
     * @param accountOldLeveragedNotional The stored notional value of the account
     */
    function _updateTracerLeverage(uint256 accountNewLeveragedNotional, uint256 accountOldLeveragedNotional) internal {
        leveragedNotionalValue = Prices.globalLeverage(
            leveragedNotionalValue,
            accountOldLeveragedNotional,
            accountNewLeveragedNotional
        );
    }

    /**
     * @notice When a liquidation occurs, Liquidation.sol needs to push this contract to update
     *         account states as necessary.
     * @param liquidator Address of the account that called liquidate(...)
     * @param liquidatee Address of the under-margined account getting liquidated
     * @param liquidatorQuoteChange Amount the liquidator's quote is changing
     * @param liquidatorBaseChange Amount the liquidator's base is changing
     * @param liquidateeQuoteChange Amount the liquidated account's quote is changing
     * @param liquidateeBaseChange Amount the liquidated account's base is changing
     * @param amountToEscrow The amount the liquidator has to put into escrow
     */
    function updateAccountsOnLiquidation(
        address liquidator,
        address liquidatee,
        int256 liquidatorQuoteChange,
        int256 liquidatorBaseChange,
        int256 liquidateeQuoteChange,
        int256 liquidateeBaseChange,
        uint256 amountToEscrow
    ) external override onlyLiquidation {
        // Limits the gas use when liquidating
        uint256 gasPrice = IOracle(gasPriceOracle).latestAnswer();
        // Update liquidators last updated gas price
        Balances.Account storage liquidatorBalance = balances[liquidator];
        Balances.Account storage liquidateeBalance = balances[liquidatee];

        // update liquidators balance
        liquidatorBalance.lastUpdatedGasPrice = gasPrice;
        liquidatorBalance.position.quote =
            liquidatorBalance.position.quote +
            liquidatorQuoteChange -
            amountToEscrow.toInt256();
        liquidatorBalance.position.base = liquidatorBalance.position.base + liquidatorBaseChange;

        // update liquidatee balance
        liquidateeBalance.position.quote = liquidateeBalance.position.quote + liquidateeQuoteChange;
        liquidateeBalance.position.base = liquidateeBalance.position.base + liquidateeBaseChange;
        _updateAccountLeverage(liquidator);
        _updateAccountLeverage(liquidatee);

        // Checks if the liquidator is in a valid position to process the liquidation
        require(userMarginIsValid(liquidator), "TCR: Liquidator under min margin");
    }

    /**
     * @notice When a liquidation receipt is claimed by the liquidator (i.e. they experienced slippage),
               Liquidation.sol needs to tell the market to update its balance and the balance of the
               liquidated agent.
     * @dev Gives the leftover amount from the receipt to the liquidated agent
     * @param claimant The liquidator, who has experienced slippage selling the liquidated position
     * @param amountToGiveToClaimant The amount the liquidator is owe based off slippage
     * @param liquidatee The account that originally got liquidated
     * @param amountToGiveToLiquidatee Amount owed to the liquidated account
     * @param amountToTakeFromInsurance Amount that needs to be taken from the insurance pool
                                        in order to cover liquidation
     */
    function updateAccountsOnClaim(
        address claimant,
        int256 amountToGiveToClaimant,
        address liquidatee,
        int256 amountToGiveToLiquidatee,
        int256 amountToTakeFromInsurance
    ) external override onlyLiquidation {
        address insuranceAddr = address(insuranceContract);
        balances[insuranceAddr].position.quote = balances[insuranceAddr].position.quote - amountToTakeFromInsurance;
        balances[claimant].position.quote = balances[claimant].position.quote + amountToGiveToClaimant;
        balances[liquidatee].position.quote = balances[liquidatee].position.quote + amountToGiveToLiquidatee;
        _updateAccountLeverage(claimant);
        _updateAccountLeverage(liquidatee);
        require(balances[insuranceAddr].position.quote >= 0, "TCR: Insurance not funded enough");
    }

    /**
     * @notice Settles an account. Compares current global rate with the users last updated rate
     *         Updates the accounts margin balance accordingly.
     * @dev Does not ensure that the account remains above margin.
     * @param account the address to settle.
     * @dev This function aggregates data to feed into account.sols settle function which sets
     */
    function settle(address account) public override {
        // Get account and global last updated indexes
        uint256 accountLastUpdatedIndex = balances[account].lastUpdatedIndex;
        uint256 globalLastUpdatedIndex = pricingContract.lastUpdatedFundingIndex();
        Balances.Account storage accountBalance = balances[account];

        if (accountBalance.position.base == 0) {
            // If user has no open positions, do not pay funding rates and mark as udpated
            accountBalance.lastUpdatedIndex = globalLastUpdatedIndex;
            accountBalance.lastUpdatedGasPrice = IOracle(gasPriceOracle).latestAnswer();
        } else if (accountLastUpdatedIndex < globalLastUpdatedIndex) {
            // If the user has not been updated with the last global funding index, apply funding rates
            Prices.FundingRateInstant memory currGlobalRate = pricingContract.getFundingRate(globalLastUpdatedIndex);
            Prices.FundingRateInstant memory currUserRate = pricingContract.getFundingRate(accountLastUpdatedIndex);
            Prices.FundingRateInstant memory currInsuranceGlobalRate = pricingContract.getInsuranceFundingRate(
                globalLastUpdatedIndex
            );
            Prices.FundingRateInstant memory currInsuranceUserRate = pricingContract.getInsuranceFundingRate(
                accountLastUpdatedIndex
            );

            // Apply the funding rate
            accountBalance.position = Prices.applyFunding(accountBalance.position, currGlobalRate, currUserRate);
            _updateAccountLeverage(account);

            // Apply the insurance funding rate if the user has leverage
            Balances.Account storage insuranceBalance = balances[address(insuranceContract)];
            if (accountBalance.totalLeveragedValue > 0) {
                (Balances.Position memory newUserPos, Balances.Position memory newInsurancePos) = Prices.applyInsurance(
                    accountBalance.position,
                    insuranceBalance.position,
                    currInsuranceGlobalRate,
                    currInsuranceUserRate,
                    accountBalance.totalLeveragedValue
                );

                balances[account].position = newUserPos;
                insuranceBalance.position = newInsurancePos;
                _updateAccountLeverage(account);
            }

            // Update account gas price
            accountBalance.lastUpdatedGasPrice = IOracle(gasPriceOracle).latestAnswer();

            // Update account index
            accountBalance.lastUpdatedIndex = globalLastUpdatedIndex;
            emit Settled(account, accountBalance.position.quote);
        }
    }

    /**
     * @notice Checks if a given accounts margin is valid
     * @param account The address of the account whose margin is to be checked
     * @return true if the margin is valid or false otherwise
     */
    function userMarginIsValid(address account) public view returns (bool) {
        Balances.Account memory accountBalance = balances[account];
        return
            Balances.marginIsValid(
                accountBalance.position,
                accountBalance.lastUpdatedGasPrice * liquidationGasCost,
                pricingContract.fairPrice(),
                trueMaxLeverage()
            );
    }

    /**
     * @notice Withdraws the fees taken on trades, and sends them to the designated
     *         fee receiver (set by the owner of the market)
     * @dev Anyone can call this function, but fees are transferred to the fee receiver.
     *      Fees is also subtracted from the total value locked in the market because
     *      fees are taken out of trades that result in users' quotes being modified, and
     *      don't otherwise get subtracted from the tvl of the market
     * @dev Emits the amount of quote tokens successfully transferred to the owner
     */
    function withdrawFees() external override {
        require(fees != 0, "TCR: no fees");
        uint256 tempFees = fees;
        fees = 0;
        tvl = tvl - tempFees;

        // Convert fees from WAD format to token representation
        uint256 rawTokenFees = Balances.wadToToken(quoteTokenDecimals, tempFees);

        // Withdraw from the account
        require(IERC20(tracerQuoteToken).transfer(feeReceiver, rawTokenFees), "TCR: Transfer failed");
        emit FeeWithdrawn(feeReceiver, rawTokenFees);
    }

    function getBalance(address account) external view override returns (Balances.Account memory) {
        return balances[account];
    }

    function setLiquidationContract(address _liquidationContract)
        external
        override
        nonZeroAddress(_liquidationContract)
        onlyOwner
    {
        liquidationContract = _liquidationContract;
        emit LiquidationContractUpdated(liquidationContract);
    }

    function setInsuranceContract(address insurance) external override nonZeroAddress(insurance) onlyOwner {
        insuranceContract = IInsurance(insurance);
        emit InsuranceContractUpdated(insurance);
    }

    function setPricingContract(address pricing) external override nonZeroAddress(pricing) onlyOwner {
        pricingContract = IPricing(pricing);
        emit PricingContractUpdated(pricing);
    }

    function setGasOracle(address _gasOracle) external override nonZeroAddress(_gasOracle) onlyOwner {
        gasPriceOracle = _gasOracle;
        emit GasOracleUpdated(gasPriceOracle);
    }

    function setFeeReceiver(address _feeReceiver) external override nonZeroAddress(_feeReceiver) onlyOwner {
        feeReceiver = _feeReceiver;
        emit FeeReceiverUpdated(_feeReceiver);
    }

    function setFeeRate(uint256 _feeRate) external override onlyOwner {
        require(_feeRate <= MAX_PERCENT_DECIMAL, "TCR: Fee rate > 100%");
        feeRate = _feeRate;
        emit FeeRateUpdated(feeRate);
    }

    function setMaxLeverage(uint256 _maxLeverage) external override onlyOwner {
        require(_maxLeverage >= lowestMaxLeverage, "TCR: Invalid max leverage");
        maxLeverage = _maxLeverage;
        emit MaxLeverageUpdated(maxLeverage);
    }

    function setFundingRateSensitivity(uint256 _fundingRateSensitivity) external override onlyOwner {
        fundingRateSensitivity = _fundingRateSensitivity;
        emit FundingRateSensitivityUpdated(fundingRateSensitivity);
    }

    function setDeleveragingCliff(uint256 _deleveragingCliff) external override onlyOwner {
        require(_deleveragingCliff <= MAX_PERCENT, "TCR: Delev cliff > 100%");
        require(_deleveragingCliff > insurancePoolSwitchStage, "TCR: Invalid delev cliff");
        deleveragingCliff = _deleveragingCliff;
        emit DeleveragingCliffUpdated(deleveragingCliff);
    }

    function setLowestMaxLeverage(uint256 _lowestMaxLeverage) external override onlyOwner {
        require(_lowestMaxLeverage <= maxLeverage, "TCR: Invalid low. max lev.");
        lowestMaxLeverage = _lowestMaxLeverage;
        emit LowestMaxLeverageUpdated(lowestMaxLeverage);
    }

    function setInsurancePoolSwitchStage(uint256 _insurancePoolSwitchStage) external override onlyOwner {
        require(_insurancePoolSwitchStage < deleveragingCliff, "TCR: Invalid pool switch");
        insurancePoolSwitchStage = _insurancePoolSwitchStage;
        emit InsurancePoolSwitchStageUpdated(insurancePoolSwitchStage);
    }

    function setLiquidationGasCost(uint256 _liquidationGasCost) external override onlyOwner {
        liquidationGasCost = _liquidationGasCost;
        emit LiquidationGasCostUpdated(liquidationGasCost);
    }

    function transferOwnership(address newOwner)
        public
        override(Ownable, ITracerPerpetualSwaps)
        nonZeroAddress(newOwner)
        onlyOwner
    {
        super.transferOwnership(newOwner);
    }

    modifier nonZeroAddress(address providedAddress) {
        require(providedAddress != address(0), "TCR: address(0) given");
        _;
    }

    /**
     * @notice allows the owner of a market to set the whitelisting of a trading interface address
     * @dev a permissioned interface may call the matchOrders function.
     * @param tradingContract the contract to have its whitelisting permissions set
     * @param whitelisted the permission of the contract. If true this contract make call makeOrder
     */
    function setWhitelist(address tradingContract, bool whitelisted) external onlyOwner {
        tradingWhitelist[tradingContract] = whitelisted;
        emit WhitelistUpdated(tradingContract, whitelisted);
    }

    // Modifier such that only the set liquidation contract can call a function
    modifier onlyLiquidation() {
        require(msg.sender == liquidationContract, "TCR: Sender not liquidation");
        _;
    }

    // Modifier such that only a whitelisted trader can call a function
    modifier onlyWhitelisted() {
        require(tradingWhitelist[msg.sender], "TCR: Contract not whitelisted");
        _;
    }

    function setAccountQuote(address account, int256 quote) external {
        Balances.Account storage userBalance = balances[account];
        userBalance.position.quote = quote;
    }

    function setLeveragedNotionalValue(uint256 value) external {
        leveragedNotionalValue = value;
    }
}
