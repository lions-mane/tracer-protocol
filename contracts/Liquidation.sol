// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/access/Ownable.sol";
import "./lib/LibMath.sol";
import "./lib/LibLiquidation.sol";
import "./lib/LibBalances.sol";
import "./Interfaces/ILiquidation.sol";
import "./Interfaces/IAccount.sol";
import "./Interfaces/ITrader.sol";
import "./Interfaces/ITracerPerpetualSwaps.sol";
import "./Interfaces/ITracerPerpetualsFactory.sol";
import "./Interfaces/IOracle.sol";
import "./Interfaces/IPricing.sol";
import "./Interfaces/IInsurance.sol";

/**
* Each call enforces that the contract calling the account is only updating the balance
* of the account for that contract.
*/
contract Liquidation is ILiquidation, Ownable {
    using LibMath for uint256;
    using LibMath for int256;

    uint256 public override currentLiquidationId;
    int256 public override maxSlippage;
    uint256 releaseTime = 15 minutes;
    IPricing public pricing;
    ITracerPerpetualSwaps public tracer;
    address public insuranceContract;

    // Receipt ID => LiquidationReceipt
    mapping(uint256 => LibLiquidation.LiquidationReceipt) public liquidationReceipts;
    // Factor to keep precision in percent calculations
    int256 private constant PERCENT_PRECISION = 10000;

    event ClaimedReceipts(address indexed liquidator, address indexed market, uint256 receiptId);
    event ClaimedEscrow(address indexed liquidatee, address indexed market, uint256 id);
    event Liquidate(address indexed account, address indexed liquidator, int256 liquidationAmount, bool side, address indexed market, uint liquidationId);
    event InvalidClaimOrder(uint256 receiptId, address indexed liquidator);

    // On contract deployment set the account contract. 
    constructor(
        address _pricing,
        address _tracer,
        address _insuranceContract,
        int256 _maxSlippage,
        address gov
    ) {
        pricing = IPricing(_pricing);
        tracer = ITracerPerpetualSwaps(_tracer);
        insuranceContract = _insuranceContract;
        maxSlippage = _maxSlippage;
        transferOwnership(gov);
    }


    /**
     * @notice Creates a liquidation receipt for a given trader
     * @param liquidator the account executing the liquidation
     * @param liquidatee the account being liquidated
     * @param price the price at which this liquidation event occurred 
     * @param escrowedAmount the amount of funds required to be locked into escrow 
     *                       by the liquidator
     * @param amountLiquidated the amount of positions that were liquidated
     * @param liquidationSide the side of the positions being liquidated. true for long
     *                        false for short.
     */
    function submitLiquidation(
        address liquidator,
        address liquidatee,
        int256 price,
        uint256 escrowedAmount,
        int256 amountLiquidated,
        bool liquidationSide
    ) internal {
        liquidationReceipts[currentLiquidationId] = LibLiquidation.LiquidationReceipt(
            address(tracer),
            liquidator,
            liquidatee,
            price,
            block.timestamp,
            escrowedAmount,
            block.timestamp + releaseTime,
            amountLiquidated,
            false,
            liquidationSide,
            false
        );
        currentLiquidationId += 1;
    }

    /**
     * @notice Marks receipts as claimed and returns the refund amount
     * @param escrowId the id of the receipt created during the liquidation event
     * @param orders the orders that sell the liquidated positions
     * @param priceMultiplier the oracle price multiplier
     * @param traderContract the address of the trader contract the selling orders were made by
     * @param liquidator the account who executed the liquidation
     */
    function calcAmountToReturn(
        uint256 escrowId,
        Types.Order[] memory orders,
        uint256 priceMultiplier,
        address traderContract,
        address liquidator
    ) public override returns (uint256) {
        LibLiquidation.LiquidationReceipt memory receipt = liquidationReceipts[escrowId];
        require(receipt.liquidator == liquidator, "LIQ: Liquidator mismatch");
        require(block.timestamp < receipt.releaseTime, "LIQ: claim time passed");
        require(!receipt.liquidatorRefundClaimed, "LIQ: Already claimed");
        require(
            tracer.tradingWhitelist(traderContract),
            "LIQ: Trader is not whitelisted"
        );

        // Validate the escrowed order was fully sold
        (uint256 unitsSold, int256 avgPrice) = calcUnitsSold(orders, traderContract, escrowId);
        require(
            unitsSold <= uint256(receipt.amountLiquidated.abs()),
            "LIQ: Unit mismatch"
        );

        // Mark refund as claimed
        liquidationReceipts[escrowId].liquidatorRefundClaimed = true;

        uint256 amountToReturn =
            LibLiquidation.calculateSlippage(
                unitsSold,
                priceMultiplier,
                maxSlippage,
                avgPrice,
                receipt
            );

        if (amountToReturn > receipt.escrowedAmount) {
            liquidationReceipts[escrowId].escrowedAmount = 0;
        } else {
            liquidationReceipts[escrowId].escrowedAmount = receipt.escrowedAmount - amountToReturn;
        }
        return amountToReturn;
    }

    /**
     * @notice Used to claim funds owed to you through your receipt. 
     * @dev Marks escrowed funds as claimed and returns amount to return
     * @param receiptId the id of the receipt from which escrow is being claimed from
     * @param liquidatee The address of the account that is getting liquidated (the liquidatee)
     */
    function claimEscrow(uint256 receiptId, address liquidatee) public override onlyTracer returns (int256) {
        LibLiquidation.LiquidationReceipt memory receipt = liquidationReceipts[receiptId];
        require(receipt.liquidatee == liquidatee, "LIQ: Liquidatee mismatch");
        require(!receipt.escrowClaimed, "LIQ: Escrow claimed");
        require(block.timestamp > receipt.releaseTime, "LIQ: Not released");
        liquidationReceipts[receiptId].escrowClaimed = true;
        return (receipt.escrowedAmount.toInt256());
    }
    

    /**
     * @notice Calculates the number of units sold and the average price of those units by a trader
     *         given multiple order
     * @param orders a list of orders for which the units sold is being calculated from
     * @param traderContract The trader contract with which the orders were made
     * @param receiptId the id of the liquidation receipt the orders are being claimed against
    */
    function calcUnitsSold(
        Types.Order[] memory orders,
        address traderContract,
        uint256 receiptId
    ) public override returns (uint256, int256) {
        LibLiquidation.LiquidationReceipt memory receipt = liquidationReceipts[receiptId];
        uint256 unitsSold;
        int256 avgPrice;
        for (uint256 i; i < orders.length; i++) {
            Types.Order memory order = ITrader(traderContract).getOrder(orders[i]);
            if (
                order.creation < receipt.time // Order made before receipt
                || order.maker != receipt.liquidator // Order made by someone who isn't liquidator
                || order.side == receipt.liquidationSide // Order is in same direction as liquidation
                /* Order should be the opposite to the position acquired on liquidation */
            ) {
                emit InvalidClaimOrder(receiptId, receipt.liquidator);
                continue;
            }

            /* order.creation >= receipt.time
             * && order.maker == receipt.liquidator
             * && order.side != receipt.liquidationSide */
            unitsSold = unitsSold + order.filled;
            avgPrice = avgPrice + (order.price * order.filled.toInt256());
        }

        // Avoid divide by 0 if no orders sold
        if (unitsSold == 0) {
            return (0, 0);
        }
        return (unitsSold, avgPrice / unitsSold.toInt256());
    }

    /**
     * @notice Returns liquidation receipt data for a given receipt id.
     * @param id the receipt id to get data for
    */
    function getLiquidationReceipt(uint256 id)
        external
        override
        view
        returns (LibLiquidation.LiquidationReceipt memory)
    {
        return liquidationReceipts[id];
    }


    function verifyAndSubmitLiquidation(
        int256 quote,
        int256 price,
        int256 base,
        int256 amount,
        uint256 priceMultiplier,
        int256 gasPrice,
        address account
    ) internal returns (uint256) {
        int256 gasCost = gasPrice * tracer.LIQUIDATION_GAS_COST().toInt256();
        int256 minMargin =
            Balances.calcMinMargin(quote, price, base, gasCost, tracer.maxLeverage(), priceMultiplier);

        require(
            Balances.calcMargin(quote, price, base, priceMultiplier) < minMargin,
            "LIQ: Account above margin"
        );
        require(amount <= quote.abs(), "LIQ: Liquidate Amount > Position");

        // calc funds to liquidate and move to Escrow
        uint256 amountToEscrow = LibLiquidation.calcEscrowLiquidationAmount(
            minMargin,
            Balances.calcMargin(quote, price, base, priceMultiplier)
        );

        // create a liquidation receipt
        bool side = quote < 0 ? false : true;
        submitLiquidation(
            msg.sender,
            account,
            price,
            amountToEscrow,
            amount,
            side
        );
        return amountToEscrow;
    }

    function calcLiquidationBalanceChanges(
        int256 liquidatedBase, int256 liquidatedQuote, address liquidator, int256 amount
    ) internal view returns (
            int256 liquidatorBaseChange,
            int256 liquidatorQuoteChange,
            int256 liquidateeBaseChange,
            int256 liquidateeQuoteChange
    ) {

        /* Liquidator's balance */
        Types.AccountBalance memory liquidatorBalance = tracer.getBalance(liquidator);
        
        // Calculates what the updated state of both accounts will be if the liquidation is fully processed
        return LibLiquidation.liquidationBalanceChanges(liquidatedBase, liquidatedQuote, liquidatorBalance.quote, amount);
    }

    /**
     * @notice Liquidates the margin account of a particular user. A deposit is needed from the liquidator. 
     *         Generates a liquidation receipt for the liquidator to use should they need a refund.
     * @param amount The amount of tokens to be liquidated 
     * @param account The account that is to be liquidated. 
     */
    function liquidate(
        int256 amount, 
        address account
    ) external override {
        require(amount > 0, "LIQ: Liquidation amount <= 0");

        /* Liquidated account's balance */
        Types.AccountBalance memory liquidatedBalance = tracer.getBalance(account);

        uint256 amountToEscrow = verifyAndSubmitLiquidation(
            liquidatedBalance.quote,
            pricing.fairPrice(),
            liquidatedBalance.base,
            amount,
            tracer.priceMultiplier(),
            liquidatedBalance.lastUpdatedGasPrice,
            account
        );
        
        // Limits the gas use when liquidating 
        require(
            tx.gasprice <= uint256(IOracle(tracer.gasPriceOracle()).latestAnswer().abs()),
            "LIQ: GasPrice > FGasPrice"
        );

        (
            int256 liquidatorBaseChange,
            int256 liquidatorQuoteChange,
            int256 liquidateeBaseChange,
            int256 liquidateeQuoteChange
        ) = calcLiquidationBalanceChanges(
            liquidatedBalance.base, liquidatedBalance.quote, msg.sender, amount
        );

        tracer.updateAccountsOnLiquidation(
            msg.sender,
            account,
            liquidatorBaseChange,
            liquidatorQuoteChange,
            liquidateeBaseChange,
            liquidateeQuoteChange,
            amountToEscrow
        );

        emit Liquidate(account, msg.sender, amount, (liquidatedBalance.quote < 0 ? false : true), address(tracer), currentLiquidationId - 1);
    }

    /**
     * @notice Allows a liquidator to submit a single liquidation receipt and multiple order ids. If the
     *         liquidator experienced slippage, will refund them a proportional amount of their deposit.
     * @param receiptId Used to identify the receipt that will be claimed
     * @param orders The orders that sold the liquidated position
     */
    function claimReceipts(
        uint256 receiptId,
        Types.Order[] memory orders,
        address traderContract
    ) external override {
        // Claim the receipts from the escrow system, get back amount to return
        LibLiquidation.LiquidationReceipt memory receipt = liquidationReceipts[receiptId];
        uint256 amountToReturn =
            calcAmountToReturn(
                receiptId,
                orders,
                tracer.priceMultiplier(),
                traderContract,
                msg.sender
            );

        // Keep track of how much was actually taken out of insurance
        uint256 amountTakenFromInsurance;
        uint256 amountToGiveToClaimant;
        uint256 amountToGiveToLiquidatee;

        /* 
         * If there was not enough escrowed, we want to call the insurance pool to help out.
         * First, check the margin of the insurance Account. If this is enough, just drain from there.
         * If this is not enough, call Insurance.drainPool to get some tokens from the insurance pool.
         * If drainPool is able to drain enough, drain from the new margin.
         * If the margin still does not have enough after calling drainPool, we are not able to fully
         * claim the receipt, only up to the amount the insurance pool allows for.
         */
        if (amountToReturn > receipt.escrowedAmount) { // Need to cover some loses with the insurance contract
            // Amount needed from insurance
            uint256 amountWantedFromInsurance = amountToReturn - receipt.escrowedAmount;

            Types.AccountBalance memory insuranceBalance = tracer.getBalance(insuranceContract);
            if (insuranceBalance.base >= amountWantedFromInsurance.toInt256()) { // We don't need to drain insurance contract
                // insuranceBalance.base = insuranceBalance.base - amountWantedFromInsurance.toInt256();
                amountTakenFromInsurance = amountWantedFromInsurance;
            } else { // insuranceBalance.base < amountWantedFromInsurance
                if (insuranceBalance.base <= 0) {
                    // attempt to drain entire balance that is needed from the pool
                    IInsurance(insuranceContract)
                        .drainPool(
                            amountWantedFromInsurance
                        );
                } else {
                    // attempt to drain the required balance taking into account the insurance balance in the account contract
                    IInsurance(insuranceContract)
                        .drainPool(
                            amountWantedFromInsurance - uint256(insuranceBalance.base)
                        );
                }
                if (insuranceBalance.base < amountWantedFromInsurance.toInt256()) { // Still not enough
                    amountTakenFromInsurance = uint(insuranceBalance.base);
                    // insuranceBalance.base = 0;
                } else { // insuranceBalance.base >= amountWantedFromInsurance
                    // insuranceBalance.base = insuranceBalance.base - amountWantedFromInsurance.toInt256();
                    amountTakenFromInsurance = amountWantedFromInsurance;
                }
            }

            amountToGiveToClaimant = receipt.escrowedAmount + amountTakenFromInsurance;
            // Don't add any to liquidatee
        } else {
            amountToGiveToClaimant = amountToReturn;
            amountToGiveToLiquidatee = receipt.escrowedAmount - amountToReturn;
        }
        tracer.updateAccountsOnReceiptClaim(
            receipt.liquidator,
            amountToGiveToClaimant.toInt256(),
            receipt.liquidatee,
            amountToGiveToLiquidatee.toInt256(),
            amountTakenFromInsurance.toInt256()
        );
        emit ClaimedReceipts(msg.sender, address(tracer), receiptId);
    }

    /**
     * @notice Allows a trader to claim escrowed funds after the escrow period has expired
     * @param receiptId The ID number of the insurance receipt from which funds are being claimed from
     */
    function claimEscrow(uint256 receiptId) public override {
        // Get receipt
        /* TODO awaiting account + tracer merge
        (address receiptTracer, , address liquidatee , , , , uint256 releaseTime, ,bool escrowClaimed , ,) = receipt.getLiquidationReceipt(receiptId);
        require(liquidatee == msg.sender, "LIQ: Not Entitled");
        require(!escrowClaimed, "LIQ: Already claimed");
        require(block.timestamp > releaseTime, "LIQ: Not yet released");
        
        // Update balance and mark as claimed
        int256 accountMargin = balances[receiptTracer][msg.sender].base;
        int256 amountToReturn = receipt.claimEscrow(receiptId, liquidatee);
        balances[receiptTracer][msg.sender].base = accountMargin.add(amountToReturn);
        emit ClaimedEscrow(msg.sender, receiptTracer, receiptId);
        */
    }

    /**
     * @notice Modifies the release time
     * @param _releaseTime new release time
     */
    function setReleaseTime(uint256 _releaseTime) external onlyOwner() {
        releaseTime = _releaseTime;
    }

    function setMaxSlippage(int256 _maxSlippage) public override onlyOwner() {
        maxSlippage = _maxSlippage;
    }

    modifier onlyTracer() {
        require(msg.sender == address(tracer), "LIQ: Caller not Tracer market");
        _;
    }
}
