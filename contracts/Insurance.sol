// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.4;

import "./Interfaces/ITracerPerpetualSwaps.sol";
import "./Interfaces/IInsurance.sol";
import "./InsurancePoolToken.sol";
import "./lib/LibMath.sol";
import {Balances} from "./lib/LibBalances.sol";
import "./lib/LibInsurance.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "prb-math/contracts/PRBMathUD60x18.sol";

contract Insurance is IInsurance {
    using LibMath for uint256;
    using LibMath for int256;

    address public immutable collateralAsset; // address of collateral asset
    uint256 public immutable collateralAssetDecimals; // decimals used by collateral asset
    uint256 public override publicCollateralAmount; // amount of underlying collateral in public pool, in WAD format
    uint256 public override bufferCollateralAmount; // amount of collateral in buffer pool, in WAD format
    address public immutable token; // token representation of a users holding in the pool

    uint256 private constant ONE_TOKEN = 1e18; // Constant for 10**18, i.e. one token in WAD format; used for drainPool

    // The insurance pool funding rate calculation can be refactored to have 0.00000570775
    // as the constant in front; see getPoolFundingRate for the formula
    // (182.648 / 8) * (5 ** 2) * (1 / (10_000 ** 2)) = 0.00000570775
    // 0.00000570775 as a WAD = 5.70775e12
    uint256 private constant INSURANCE_FUNDING_RATE_FACTOR = 5.70775e12;

    // Target percent of leveraged notional value in the market for the insurance pool to meet; 1% by default
    uint256 private constant INSURANCE_POOL_TARGET_PERCENT = 1e16;

    ITracerPerpetualSwaps public tracer; // Tracer associated with Insurance Pool

    event InsuranceDeposit(address indexed market, address indexed user, uint256 indexed amount);
    event InsuranceWithdraw(address indexed market, address indexed user, uint256 indexed amount);

    constructor(address _tracer) {
        require(_tracer != address(0), "INS: _tracer = address(0)");
        tracer = ITracerPerpetualSwaps(_tracer);
        InsurancePoolToken _token = new InsurancePoolToken("Tracer Pool Token", "TPT");
        token = address(_token);
        collateralAsset = tracer.tracerQuoteToken();
        collateralAssetDecimals = tracer.quoteTokenDecimals();
    }

    /**
     * @notice Allows a user to deposit to a given tracer market insurance pool
     * @dev Mints amount of the pool token to the user
     * @param amount the amount of tokens to deposit. Provided in WAD format
     */
    function deposit(uint256 amount) external override {
        IERC20 collateralToken = IERC20(collateralAsset);

        // convert token amount to WAD
        uint256 rawTokenAmount = Balances.wadToToken(collateralAssetDecimals, amount);
        require(collateralToken.transferFrom(msg.sender, address(this), rawTokenAmount), "INS: Transfer failed");

        // amount in wad format after being converted from token format
        uint256 wadAmount = uint256(Balances.tokenToWad(collateralAssetDecimals, rawTokenAmount));

        // Update pool balances and user
        updatePoolAmount();
        InsurancePoolToken poolToken = InsurancePoolToken(token);

        // tokens to mint = (pool token supply / collateral holdings) * collateral amount to stake
        uint256 tokensToMint = LibInsurance.calcMintAmount(poolToken.totalSupply(), publicCollateralAmount, wadAmount);

        // mint pool tokens, hold collateral tokens
        poolToken.mint(msg.sender, tokensToMint);
        publicCollateralAmount = publicCollateralAmount + wadAmount;
        emit InsuranceDeposit(address(tracer), msg.sender, wadAmount);
    }

    /**
     * @notice Allows a user to withdraw their assets from a given insurance pool
     * @dev burns amount of tokens from the pool token
     * @param amount the amount of pool tokens to burn. Provided in WAD format
     */
    function withdraw(uint256 amount) external override {
        updatePoolAmount();
        uint256 balance = getPoolUserBalance(msg.sender);
        require(balance >= amount, "INS: balance < amount");

        IERC20 collateralToken = IERC20(collateralAsset);
        InsurancePoolToken poolToken = InsurancePoolToken(token);

        // tokens to return = (collateral holdings / pool token supply) * amount of pool tokens to withdraw
        uint256 wadTokensToSend = LibInsurance.calcWithdrawAmount(
            poolToken.totalSupply(),
            publicCollateralAmount,
            amount
        );

        // convert token amount to raw amount from WAD
        uint256 rawTokenAmount = Balances.wadToToken(collateralAssetDecimals, wadTokensToSend);

        // pool amount is always in WAD format
        publicCollateralAmount = publicCollateralAmount - wadTokensToSend;

        // burn pool tokens, return collateral tokens
        poolToken.burnFrom(msg.sender, amount);
        require(collateralToken.transfer(msg.sender, rawTokenAmount), "INS: Transfer failed");

        emit InsuranceWithdraw(address(tracer), msg.sender, wadTokensToSend);
    }

    /**
     * @notice Internally updates a given tracer's pool amount according to the tracer contract
     * @dev Withdraws from tracer, and adds amount to the pool's amount field.
     */
    function updatePoolAmount() public override {
        uint256 quote = uint256((tracer.getBalance(address(this))).position.quote);

        tracer.withdraw(quote);

        if (publicCollateralAmount > 0) {
            // Amount to pay to public is the ratio of public collateral amount to total funds
            uint256 payToPublic = PRBMathUD60x18.mul(
                quote,
                PRBMathUD60x18.div(publicCollateralAmount, getPoolHoldings())
            );

            publicCollateralAmount = publicCollateralAmount + payToPublic;

            // Amount to pay to buffer is the remainder
            bufferCollateralAmount = bufferCollateralAmount + quote - payToPublic;
        } else {
            // Pay to buffer if nothing in public insurance
            bufferCollateralAmount = bufferCollateralAmount + quote;
        }
    }

    /**
     * @notice Deposits some of the insurance pool's amount into the tracer contract
     * @dev If amount is greater than the insurance pool's balance, deposit total balance.
     *      This was done because in such an emergency situation, we want to recover as much as possible
     * @param amount The desired amount to take from the insurance pool
     */
    function drainPool(uint256 amount) external override onlyLiquidation {
        IERC20 tracerMarginToken = IERC20(collateralAsset);

        uint256 poolHoldings = getPoolHoldings();

        if (amount >= poolHoldings) {
            // If public collateral left after draining is less than 1 token, we want to keep it at 1 token
            if (publicCollateralAmount > ONE_TOKEN) {
                // Leave 1 token for the public pool
                amount = poolHoldings - ONE_TOKEN;
                publicCollateralAmount = ONE_TOKEN;
            } else {
                amount = bufferCollateralAmount;
            }

            // Drain buffer
            bufferCollateralAmount = 0;
        } else if (amount > bufferCollateralAmount) {
            if (publicCollateralAmount < ONE_TOKEN) {
                // If there's not enough public collateral for there to be 1 token, cap amount being drained at the buffer
                amount = bufferCollateralAmount;
            } else if (poolHoldings - amount < ONE_TOKEN) {
                // If the amount of collateral left in the public insurance would be less than 1 token, cap amount being drained
                // from the public insurance such that 1 token is left in the public buffer
                amount = poolHoldings - ONE_TOKEN;
                publicCollateralAmount = ONE_TOKEN;
            } else {
                // Take out what you need from the public pool; there's enough for there to be >= 1 token left
                publicCollateralAmount = publicCollateralAmount - (amount - bufferCollateralAmount);
            }

            // Drain buffer
            bufferCollateralAmount = 0;
        } else {
            // Only need to take part of buffer pool out
            bufferCollateralAmount = bufferCollateralAmount - amount;
        }

        uint256 rawTokenAmount = Balances.wadToToken(collateralAssetDecimals, amount);
        tracerMarginToken.approve(address(tracer), rawTokenAmount);
        tracer.deposit(amount);
    }

    /**
     * @notice gets a users balance in a given insurance pool
     * @param user the user whose balance is being retrieved
     */
    function getPoolUserBalance(address user) public view override returns (uint256) {
        return InsurancePoolToken(token).balanceOf(user);
    }

    /**
     * @notice Get total holdings of the insurance pool (= public + buffer collateral)
     */
    function getPoolHoldings() public view override returns (uint256) {
        return bufferCollateralAmount + publicCollateralAmount;
    }

    /**
     * @notice Gets the target fund amount for a given insurance pool
     * @dev The target amount is 1% of the leveraged notional value of the tracer being insured.
     */
    function getPoolTarget() public view override returns (uint256) {
        return PRBMathUD60x18.mul(tracer.leveragedNotionalValue(), INSURANCE_POOL_TARGET_PERCENT);
    }

    /**
     * @notice Gets the 8 hour funding rate for an insurance pool
     * @dev the funding rate is represented as
     *      (182.648 / 8) * (5 * ((fundTarget - fundHoldings) / (fundTarget * 10_000))) ** 2
     */
    function getPoolFundingRate() external view override returns (uint256) {
        uint256 poolHoldings = getPoolHoldings();
        uint256 poolTarget = getPoolTarget();

        // If the pool is above the target, we don't pay the insurance funding rate
        if (poolTarget <= poolHoldings) {
            return 0;
        }

        // (poolFundingNeeded / poolTarget) is less than 10**18, which you cannot square using PRB-math;
        // thus, we do the multiplication manually
        uint256 poolFundingNeeded = poolTarget - poolHoldings;
        uint256 numerator = PRBMathUD60x18.mul(poolFundingNeeded, poolFundingNeeded);
        uint256 denominator = PRBMathUD60x18.mul(poolTarget, poolTarget);

        uint256 ratio = PRBMathUD60x18.div(numerator, denominator);

        return PRBMathUD60x18.mul(INSURANCE_FUNDING_RATE_FACTOR, ratio);
    }

    modifier onlyLiquidation() {
        require(msg.sender == tracer.liquidationContract(), "INS: sender not LIQ contract");
        _;
    }
}
