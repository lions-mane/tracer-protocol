const mockPerpsAbi = require("../abi/contracts/test/TracerPerpetualSwapsMock.sol/TracerPerpetualSwapsMock.json")

/**
 * Create a deployment with a Mock Tracer contract for insurance tests.
 * The quote token is deployed with 18 decimals.
 * This is so no conversion to token values is required when calling ERC20 functions in tests.
 */
module.exports = async function (hre) {
    const { deployments, getNamedAccounts, ethers } = hre
    const { deploy, execute } = deployments
    const { deployer, acc1, acc2, acc3 } = await getNamedAccounts()
    const signers = await ethers.getSigners()
    // deploy libs
    const libMath = await deploy("LibMath", {
        from: deployer,
        log: true,
    })
    const libPerpetuals = await deploy("Perpetuals", {
        from: deployer,
        log: true,
    })
    const libBalances = await deploy("Balances", {
        from: deployer,
        log: true,
    })
    const libLiquidation = await deploy("LibLiquidation", {
        from: deployer,
        log: true,
    })
    const libPricing = await deploy("Prices", {
        from: deployer,
        log: true,
    })
    const libInsurance = await deploy("LibInsurance", {
        from: deployer,
        log: true,
    })

    // deploy trader
    const trader = await deploy("Trader", {
        from: deployer,
        log: true,
        contract: "TraderMock",
    })

    // deploy oracles
    // asset price oracle => ETH / USD feed
    const priceOracle = await deploy("PriceOracle", {
        from: deployer,
        log: true,
        contract: "ChainlinkOracle",
    })

    // gas price oracle => Fast gas / Gwei feed
    const gasOracle = await deploy("GasOracle", {
        from: deployer,
        log: true,
        contract: "ChainlinkOracle",
    })

    // mock eth oracle => ETH / USD feed
    // used only in local testing to set the gas price separately to eth price
    const ethOracle = await deploy("EthOracle", {
        from: deployer,
        log: true,
        contract: "ChainlinkOracle",
    })

    await execute(
        "EthOracle",
        { from: deployer, log: true },
        "setDecimals",
        "8"
    )

    await execute(
        "EthOracle",
        { from: deployer, log: true },
        "setPrice",
        "300000000000" // 3000 USD / ETH
    )

    await execute(
        "GasOracle",
        { from: deployer, log: true },
        "setDecimals",
        "9"
    )

    await execute(
        "GasOracle",
        { from: deployer, log: true },
        "setPrice",
        "20000000000" // 20 Gwei
    )

    // price oracle adapter => ETH / USD WAD feed
    const oracleAdapter = await deploy("PriceOracleAdapter", {
        from: deployer,
        log: true,
        args: [priceOracle.address],
        contract: "OracleAdapter",
    })

    // gas USD price feed => Fast Gas / USD WAD feed
    const gasPriceOracle = await deploy("GasPriceOracle", {
        from: deployer,
        log: true,
        args: [ethOracle.address, gasOracle.address],
        contract: "GasOracle",
    })

    // deploy token with an initial supply of 100000 and 18 decimals
    const token = await deploy("QuoteToken", {
        args: [ethers.utils.parseEther("10000000"), "Test Token", "TST", 18], //10 mil supply
        from: deployer,
        log: true,
        contract: "TestToken",
    })

    // distribute tokens to accounts
    const tokenAmount = ethers.utils.parseEther("10000")
    await execute(
        "QuoteToken",
        { from: deployer, log: true },
        "transfer",
        acc1,
        tokenAmount
    )
    await execute(
        "QuoteToken",
        { from: deployer, log: true },
        "transfer",
        acc2,
        tokenAmount
    )
    await execute(
        "QuoteToken",
        { from: deployer, log: true },
        "transfer",
        acc3,
        tokenAmount
    )

    // deploy deployers
    const liquidationDeployer = await deploy("LiquidationDeployerV1", {
        from: deployer,
        libraries: {
            LibLiquidation: libLiquidation.address,
            Balances: libBalances.address,
            LibMath: libMath.address,
        },
        log: true,
    })

    const insuranceDeployer = await deploy("InsuranceDeployerV1", {
        from: deployer,
        libraries: {
            LibMath: libMath.address,
            Balances: libBalances.address,
            Insurance: libInsurance.address,
        },
        log: true,
    })

    const pricingDeployer = await deploy("PricingDeployerV1", {
        from: deployer,
        libraries: {
            LibMath: libMath.address,
            Prices: libPricing.address,
        },
        log: true,
    })

    // deploy Tracer perps deployer
    const perpsDeployer = await deploy("PerpsDeployerMock", {
        from: deployer,
        libraries: {
            Perpetuals: libPerpetuals.address,
            LibMath: libMath.address,
            Balances: libBalances.address,
            Prices: libPricing.address,
        },
        log: true,
    })

    // deploy Tracer perps factory
    await deploy("TracerPerpetualsFactory", {
        args: [
            perpsDeployer.address,
            liquidationDeployer.address,
            insuranceDeployer.address,
            pricingDeployer.address,
            deployer, // governance address
        ],
        from: deployer,
        log: true,
    })

    let maxLeverage = ethers.utils.parseEther("12.5")
    let feeRate = 0 // 0 percent
    let fundingRateSensitivity = ethers.utils.parseEther("1")
    let maxLiquidationSlippage = ethers.utils.parseEther("0.5") // 50 percent
    let deleveragingCliff = ethers.utils.parseEther("20") // 20 percent
    let lowestMaxLeverage = ethers.utils.parseEther("12.5") // Default -> Doesn't go down
    let insurancePoolSwitchStage = ethers.utils.parseEther("1") // Switches mode at 1%
    let liquidationGasCost = 63516

    var deployTracerData = ethers.utils.defaultAbiCoder.encode(
        [
            "bytes32", //_marketId,
            "address", //_tracerQuoteToken,
            "address", //_gasPriceOracle,
            "uint256", //_maxLeverage,
            "uint256", //_fundingRateSensitivity,
            "uint256", //_feeRate
            "address", // _feeReceiver,
            "uint256", // _deleveragingCliff
            "uint256", // _lowestMaxLeverage
            "uint256", // _insurancePoolSwitchStage
            "uint256", // _liquidationGasCost
        ],
        [
            ethers.utils.formatBytes32String("TEST1/USD"),
            token.address,
            gasPriceOracle.address,
            maxLeverage,
            fundingRateSensitivity,
            feeRate,
            deployer,
            deleveragingCliff,
            lowestMaxLeverage,
            insurancePoolSwitchStage,
            liquidationGasCost,
        ]
    )

    // this deploys a tracer, insurance, pricing and liquidation contract
    await deployments.execute(
        "TracerPerpetualsFactory",
        {
            from: deployer,
            log: true,
        },
        "deployTracer",
        deployTracerData,
        oracleAdapter.address,
        gasOracle.address,
        maxLiquidationSlippage
    )

    // whitelist the trader
    const tracerInstance = new ethers.Contract(
        await deployments.read("TracerPerpetualsFactory", "tracersByIndex", 0),
        mockPerpsAbi
    ).connect(signers[0])

    await tracerInstance.setWhitelist(trader.address, true)
}
module.exports.tags = ["MockTracerDeploy"]
