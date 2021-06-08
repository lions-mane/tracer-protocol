const { expect } = require("chai")
const { ethers, getNamedAccounts, deployments } = require("hardhat")
const { deploy } = deployments
const { smockit } = require("@eth-optimism/smock")
const { BigNumber } = require("ethers")
const zeroAddress = "0x0000000000000000000000000000000000000000"

const getCollaterals = async (myClass) => [
    await myClass.bufferCollateralAmount(),
    await myClass.publicCollateralAmount(),
]

const putAndTakeCollateral = async (
    tracer,
    testToken,
    insurance,
    bufferValue,
    publicValue,
    amountToDrain
) => {
    tracer.smocked.getBalance.will.return.with({
        position: { quote: ethers.utils.parseEther(bufferValue), base: 0 }, // quote, base
        totalLeveragedValue: 0, // total leverage
        lastUpdatedIndex: 0, // last updated index
        lastUpdatedGasPrice: 0, // last updated gas price
    })

    await insurance.updatePoolAmount()
    
    // return await getCollaterals(insurance)

    tracer.smocked.getBalance.will.return.with({
        position: { quote: ethers.utils.parseEther(publicValue), base: 0 }, // quote, base
        totalLeveragedValue: 0, // total leverage
        lastUpdatedIndex: 0, // last updated index
        lastUpdatedGasPrice: 0, // last updated gas price
    })

    await testToken.approve(
        insurance.address,
        ethers.utils.parseEther(publicValue)
    )

    await insurance.deposit(ethers.utils.parseEther(publicValue))

    await insurance.updatePoolAmount()

    // await insurance.drainPool(amountToDrain)

    return await getCollaterals(insurance)
}

// create hardhat optimised feature
const setup = deployments.createFixture(async () => {
    const { deployer } = await getNamedAccounts()
    _deployer = deployer
    // deploy a test token
    const TestToken = await ethers.getContractFactory("TestToken")
    let testToken = await TestToken.deploy(ethers.utils.parseEther("100000000"))
    await testToken.deployed()

    // deploy mock tracer and libs
    let libBalances = await deploy("Balances", {
        from: deployer,
        log: true,
    })

    let libPerpetuals = await deploy("Perpetuals", {
        from: deployer,
        log: true,
    })

    let libPrices = await deploy("Prices", {
        from: deployer,
        log: true,
    })

    // this deploy method is needed for mocking
    const tracerContractFactory = await ethers.getContractFactory(
        "TracerPerpetualSwaps",
        {
            libraries: {
                Perpetuals: libPerpetuals.address,
                Prices: libPrices.address,
            },
        }
    )
    const tracer = await tracerContractFactory.deploy(
        ethers.utils.formatBytes32String("TEST/USD"),
        testToken.address,
        18,
        zeroAddress,
        1,
        1,
        1,
        zeroAddress
    )

    let mockTracer = await smockit(tracer)

    // mock tracer calls that are needed
    // get balance for this account to return 0
    // NOTE: If any test changes mocks, due to Hardhat fixture optimisations,
    // the mock defaults set here WILL NOT be returned. You need to manually
    // change the mock state back to its expected value at the end of the test.
    mockTracer.smocked.getBalance.will.return.with({
        position: { quote: 0, base: 0 }, //quote, base
        totalLeveragedValue: 0, //total leverage
        lastUpdatedIndex: 0, //last updated index
        lastUpdatedGasPrice: 0, //last updated gas price
    })

    // token to return the testToken address
    mockTracer.smocked.tracerQuoteToken.will.return.with(testToken.address)

    // leveraged notional value to return 100
    mockTracer.smocked.leveragedNotionalValue.will.return.with(
        ethers.utils.parseEther("100")
    )

    // quote token decimals
    mockTracer.smocked.quoteTokenDecimals.will.return.with(18)

    // deposit and withdraw to return nothing
    mockTracer.smocked.deposit.will.return()
    mockTracer.smocked.withdraw.will.return()

    // deploy insurance using mock tracer
    const Insurance = await ethers.getContractFactory("Insurance")
    let insurance = await Insurance.deploy(mockTracer.address)
    await insurance.deployed()
    return {
        testToken,
        mockTracer,
        insurance,
    }
})

describe("Unit tests: Insurance.sol", function () {
    let accounts
    let testToken
    let mockTracer
    let insurance

    beforeEach(async function () {
        const _setup = await setup()
        testToken = _setup.testToken
        mockTracer = _setup.mockTracer
        insurance = _setup.insurance
        accounts = await ethers.getSigners()
    })

    describe("constructor", async () => {
        context("when sucessfully deployed", async () => {
            it("deploys a new pool token", async () => {
                let poolToken = await insurance.token()
                expect(poolToken.toString()).to.not.equal(
                    zeroAddress.toString()
                )
            })
            it("uses the same collateral as the quote of the market", async () => {
                let collateralToken = await insurance.collateralAsset()
                expect(collateralToken.toString()).to.equal(testToken.address)
            })
            it("emits a pool created event", async () => {})
        })
    })

    describe("deposit", async () => {
        context("when the user does not have enough tokens", async () => {
            it("reverts", async () => {
                await expect(
                    insurance.deposit(ethers.utils.parseEther("1"))
                ).to.be.revertedWith("ERC20: transfer amount exceeds allowance")
            })
        })

        context("when the user has enough tokens", async () => {
            beforeEach(async () => {
                await testToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("1")
                )
                await insurance.deposit(ethers.utils.parseEther("1"))
            })

            it("mints them pool tokens", async () => {
                let poolTokenHolding = await insurance.getPoolUserBalance(
                    accounts[0].address
                )
                expect(poolTokenHolding).to.equal(ethers.utils.parseEther("1"))
            })

            it("increases the collateral holding of the insurance fund", async () => {
                let collateralHolding = await insurance.publicCollateralAmount()
                expect(collateralHolding).to.equal(ethers.utils.parseEther("1"))
            })

            it("pulls in collateral from the tracer market", async () => {
                let balanceCalls = mockTracer.smocked.getBalance.calls.length
                expect(balanceCalls).to.equal(1)
            })

            it("emits an insurance deposit event", async () => {})
        })
    })

    describe("withdraw", async () => {
        context("when the user does not have enough pool tokens", async () => {
            it("reverts", async () => {
                await expect(
                    insurance.withdraw(ethers.utils.parseEther("1"))
                ).to.be.revertedWith("INS: balance < amount")
            })
        })

        context("when the user has enough pool tokens", async () => {
            beforeEach(async () => {
                // get user tp acquire some pool tokens
                await testToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("2")
                )
                await insurance.deposit(ethers.utils.parseEther("2"))
                // get user to burn some pool tokens
                await insurance.withdraw(ethers.utils.parseEther("1"))
            })

            it("burns pool tokens", async () => {
                let poolTokenHolding = await insurance.getPoolUserBalance(
                    accounts[0].address
                )
                expect(poolTokenHolding).to.equal(ethers.utils.parseEther("1"))
            })

            it("decreases the collateral holdings of the insurance fund", async () => {
                let collateralHolding = await insurance.publicCollateralAmount()
                expect(collateralHolding).to.equal(ethers.utils.parseEther("1"))
            })

            it("pulls in collateral from the tracer market", async () => {
                let balanceCalls = mockTracer.smocked.getBalance.calls.length
                expect(balanceCalls).to.equal(1)
            })

            it("emits an insurance withdraw event", async () => {})
        })
    })

    describe("updatePoolAmount", async () => {
        context("when there are funds to pull", async () => {
            it("pulls funds and updates the collateral holding of the pool", async () => {})
        })

        context("when there are no funds to pull", async () => {
            it("does nothing", async () => {
                let publicCollateralAmountPre =
                    await insurance.publicCollateralAmount()
                let bufferCollateralAmountPre =
                    await insurance.bufferCollateralAmount()

                await insurance.updatePoolAmount()

                let publicCollateralAmountPost =
                    await insurance.publicCollateralAmount()
                let bufferCollateralAmountPost =
                    await insurance.bufferCollateralAmount()

                // ensure tracer.withdraw was called
                expect(mockTracer.smocked.withdraw.calls.length).to.equal(0)

                expect(publicCollateralAmountPost).to.equal(
                    ethers.utils.parseEther("0")
                )
                expect(bufferCollateralAmountPost).to.equal(
                    ethers.utils.parseEther("0")
                )
            })
        })
    })

    describe("drainPool", async () => {
        context("when called by insurance", async () => {
            beforeEach(async () => {
                // mock ourselvse as the liquidation contract
                mockTracer.smocked.liquidationContract.will.return.with(
                    accounts[0].address
                )
            })

            after(async () => {
                // return mock to its previous state
                mockTracer.smocked.liquidationContract.will.return.with(
                    zeroAddress
                )
            })

            it.only("drains everything but 1 unit of public collateral when amount wanted is greater than the pool amount", async () => {
                let bufferCollateralAmountPre = "1",
                    publicCollateralAmountPre = "1",
                    amountToDrain = "0"
                let bufferCollateralAmountPost, publicCollateralAmountPost

                mockTracer.smocked.getBalance.will.return.with()

                [bufferCollateralAmountPost, publicCollateralAmountPost] =
                    await putAndTakeCollateral(
                        mockTracer,
                        testToken,
                        insurance,
                        bufferCollateralAmountPre,
                        publicCollateralAmountPre,
                        amountToDrain
                    )

                expect(bufferCollateralAmountPost).to.equal(
                    // bufferCollateralAmountPre
                    ethers.utils.parseEther("1")
                )
                expect(publicCollateralAmountPost).to.equal(
                    // publicCollateralAmountPre
                    ethers.utils.parseEther("1")
                )
            })

            it("does nothing if there is less than 1 unit of public collateral + no public buffer collateral", async () => {})
            it("does nothing if there is less than 1 unit of public collateral + no public buffer collateral", async () => {})
            it("does nothing if there is less than 1 unit of public collateral + no public buffer collateral", async () => {})
            it("does nothing if there is less than 1 unit of public collateral + no public buffer collateral", async () => {})
            it("does nothing if there is less than 1 unit of public collateral + no public buffer collateral", async () => {})
            it("does nothing if there is less than 1 unit of public collateral + no public buffer collateral", async () => {})
            it("does nothing if there is less than 1 unit of public collateral + no public buffer collateral", async () => {
                let publicCollateralAmountPre =
                    await insurance.publicCollateralAmount()
                await insurance.drainPool(ethers.utils.parseEther("1"))
                let publicCollateralAmountPost =
                    await insurance.publicCollateralAmount()
                // ensure collateral hasn't changed
                expect(
                    publicCollateralAmountPost.sub(publicCollateralAmountPre)
                ).to.equal(ethers.utils.parseEther("0"))
            })

            it("caps the amount to drain to the pool's collateral holding + no public buffer", async () => {
                // set collateral holdings to 5
                await testToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("5")
                )
                await insurance.deposit(ethers.utils.parseEther("5"))

                // try withdraw 10 from the pool
                let publicCollateralAmountPre =
                    await insurance.publicCollateralAmount()
                await insurance.drainPool(ethers.utils.parseEther("10"))
                let publicCollateralAmountPost =
                    await insurance.publicCollateralAmount()

                expect(
                    publicCollateralAmountPre.sub(publicCollateralAmountPost)
                ).to.equal(ethers.utils.parseEther("4"))
            })

            it("caps the amount to drain to the pools public collateral holding + no public buffer", async () => {
                // set collateral holdings to 5
                await testToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("5")
                )
                await insurance.deposit(ethers.utils.parseEther("5"))

                // try withdraw 10 from the pool
                let publicCollateralAmountPre =
                    await insurance.publicCollateralAmount()
                await insurance.drainPool(ethers.utils.parseEther("10"))
                let publicCollateralAmountPost =
                    await insurance.publicCollateralAmount()

                // Only take out 4 tokens
                expect(
                    publicCollateralAmountPre.sub(publicCollateralAmountPost)
                ).to.equal(ethers.utils.parseEther("4"))
                // Expect there to be one left
                expect(publicCollateralAmountPost).to.equal(
                    ethers.utils.parseEther("1")
                )
            })

            it("deposits into the market", async () => {
                // set collateral holdings to 5
                await testToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("5")
                )
                await insurance.deposit(ethers.utils.parseEther("5"))

                // try withdraw 10 from the pool
                await insurance.drainPool(ethers.utils.parseEther("1"))
                expect(mockTracer.smocked.deposit.calls.length).to.equal(1)
            })

            it("correctly updates the pools collateral holding", async () => {
                await testToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("5")
                )
                await insurance.deposit(ethers.utils.parseEther("5"))

                // withdraw from pool
                await insurance.drainPool(ethers.utils.parseEther("2"))
                let publicCollateralAmountPost =
                    await insurance.publicCollateralAmount()

                expect(publicCollateralAmountPost).to.equal(
                    ethers.utils.parseEther("3")
                )
            })
        })

        context("when called by someone other than insurance", async () => {
            it("reverts", async () => {
                await expect(
                    insurance.drainPool(ethers.utils.parseEther("1"))
                ).to.be.revertedWith("INS: sender is not Liquidation contract")
            })
        })
    })

    describe("getPoolBalance", async () => {
        context("when called", async () => {
            it("returns the balance of a user in terms of the pool token", async () => {
                await testToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("2")
                )
                await insurance.deposit(ethers.utils.parseEther("2"))
                let poolBalance = await insurance.getPoolUserBalance(
                    accounts[0].address
                )
                expect(poolBalance).to.equal(ethers.utils.parseEther("2"))
            })
        })
    })

    describe("getPoolTarget", async () => {
        context("when called", async () => {
            it("returns 1% of the markets leveraged notional value", async () => {
                let poolTarget = await insurance.getPoolTarget()
                expect(poolTarget).to.equal(ethers.utils.parseEther("1"))
                // uses leveraged notional value to compute
                let leveragedNotionalCalls =
                    mockTracer.smocked.leveragedNotionalValue.calls.length
                expect(leveragedNotionalCalls).to.equal(1)
            })
        })
    })

    describe("getPoolFundingRate", async () => {
        context("when the leveraged notional value is <= 0", async () => {
            it("returns 0", async () => {
                // set leveraged notional value to 0
                mockTracer.smocked.leveragedNotionalValue.will.return.with(
                    ethers.utils.parseEther("0")
                )

                let poolFundingRate = await insurance.getPoolFundingRate()
                expect(poolFundingRate).to.equal(0)
            })
        })

        context("when the leveraged notional value is > 0", async () => {
            it("returns the appropriate 8 hour funding rate", async () => {
                // set leveraged notional value to 100
                mockTracer.smocked.leveragedNotionalValue.will.return.with(
                    ethers.utils.parseEther("100")
                )

                let poolFundingRate = await insurance.getPoolFundingRate()
                // 0.0036523 * (poolTarget - collateralHolding) / leveragedNotionalValue))
                // poolTarget = 100 / 1 = 1
                // collateral = 0
                // leveragedNotionalValue = 100
                // ratio = (poolTarget - collateral) / levNotionalValue = 0.01
                let ratio = ethers.utils.parseEther("0.01")
                let expectedFundingRate = ethers.utils
                    .parseEther("0.0036523")
                    .mul(ratio)
                    .div(ethers.utils.parseEther("1")) //divide by 1 to simulate WAD math division
                expect(poolFundingRate).to.equal(expectedFundingRate)
            })
        })
    })
})
