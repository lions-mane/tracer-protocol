const { expect } = require("chai")
const { ethers, deployments } = require("hardhat")
const {
    getQuoteToken,
    getInsurance,
    getMockTracer,
} = require("../util/DeploymentUtil")
const {
    expectCollaterals,
    setCollaterals,
    setAndDrainCollaterals,
} = require("../util/InsuranceUtil")

const zeroAddress = "0x0000000000000000000000000000000000000000"

const setupTests = deployments.createFixture(async () => {
    await deployments.fixture(["MockTracerDeploy"])
    tracer = await getMockTracer()

    // set liquidation contract to accounts[0]
    accounts = await ethers.getSigners()
    tracer.setLiquidationContract(accounts[0].address)

    // connect to insurance as liquidation contract
    let insurance = await getInsurance(tracer)
    insurance = await insurance.connect(accounts[0])

    return {
        quoteToken: await getQuoteToken(tracer),
        tracer: tracer,
        insurance: insurance,
    }
})

describe("Unit tests: Insurance.sol", function () {
    let quoteToken
    let tracer
    let insurance

    beforeEach(async function () {
        ;({ quoteToken, tracer, insurance } = await setupTests())
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
                expect(collateralToken.toString()).to.equal(quoteToken.address)
            })
        })
    })

    describe("updatePoolAmount", async () => {
        context("when there is only buffer funds", async () => {
            it("pulls funds and updates the collateral holding of the pool", async () => {
                let bufferValue = ethers.utils.parseEther("1")
                let publicValue = ethers.utils.parseEther("0")

                await setCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferValue,
                    publicValue
                )

                const fundingPaymentsHeld = ethers.utils.parseEther("2")

                await quoteToken.approve(tracer.address, fundingPaymentsHeld)
                await tracer.depositToAccount(
                    insurance.address,
                    fundingPaymentsHeld
                )

                await insurance.updatePoolAmount()

                const expectedBuffer = ethers.utils.parseEther("3")
                const expectedPublic = ethers.utils.parseEther("0")
                await expectCollaterals(
                    insurance,
                    expectedBuffer,
                    expectedPublic
                )
            })
        })

        context("when there is both public and buffer funds", async () => {
            it("pulls funds and updates the collateral holding of the pool", async () => {
                let bufferValue = ethers.utils.parseEther("1")
                let publicValue = ethers.utils.parseEther("1")

                await setCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferValue,
                    publicValue
                )

                const fundingPaymentsHeld = ethers.utils.parseEther("1")
                await quoteToken.approve(tracer.address, fundingPaymentsHeld)
                await tracer.depositToAccount(
                    insurance.address,
                    fundingPaymentsHeld
                )

                await insurance.updatePoolAmount()

                const expectedBuffer = ethers.utils.parseEther("1.5")
                const expectedPublic = ethers.utils.parseEther("1.5")
                await expectCollaterals(
                    insurance,
                    expectedBuffer,
                    expectedPublic
                )
            })
        })

        context("when there are no funds to pull", async () => {
            it("does nothing", async () => {
                const fundingPaymentsHeld = ethers.utils.parseEther("0")
                await quoteToken.approve(tracer.address, fundingPaymentsHeld)
                await tracer.depositToAccount(
                    insurance.address,
                    fundingPaymentsHeld
                )

                await insurance.updatePoolAmount()

                const expectedBuffer = ethers.utils.parseEther("0")
                const expectedPublic = ethers.utils.parseEther("0")
                await expectCollaterals(
                    insurance,
                    expectedBuffer,
                    expectedPublic
                )
            })
        })
    })

    describe("drainPool", async () => {
        context("when called by liquidation", async () => {
            it("drains all but one token in public when there's more than one", async () => {
                let bufferCollateralAmountPre = ethers.utils.parseEther("1"),
                    publicCollateralAmountPre = ethers.utils.parseEther("1.05"),
                    amountToDrain = ethers.utils.parseEther("3")

                await setAndDrainCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmountPre,
                    publicCollateralAmountPre,
                    amountToDrain
                )

                const expectedBuffer = ethers.utils.parseEther("0")
                const expectedPublic = ethers.utils.parseEther("1")
                expectCollaterals(insurance, expectedBuffer, expectedPublic)
            })

            it("drains all but however much is left in public when less than one", async () => {
                let bufferCollateralAmountPre = ethers.utils.parseEther("1"),
                    publicCollateralAmountPre = ethers.utils.parseEther("0.95"),
                    amountToDrain = ethers.utils.parseEther("3")

                await setAndDrainCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmountPre,
                    publicCollateralAmountPre,
                    amountToDrain
                )

                const expectedBuffer = ethers.utils.parseEther("0")
                expectCollaterals(
                    insurance,
                    expectedBuffer,
                    publicCollateralAmountPre
                )
            })

            it("drains all but however much is left in public when less than one", async () => {
                let bufferCollateralAmountPre = ethers.utils.parseEther("1"),
                    publicCollateralAmountPre = ethers.utils.parseEther("0.95"),
                    amountToDrain = ethers.utils.parseEther("3")

                await setAndDrainCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmountPre,
                    publicCollateralAmountPre,
                    amountToDrain
                )

                const expectedBuffer = ethers.utils.parseEther("0")
                expectCollaterals(
                    insurance,
                    expectedBuffer,
                    publicCollateralAmountPre
                )
            })

            it("drains all of the buffer, and some public while leaving < one token", async () => {
                let bufferCollateralAmountPre = ethers.utils.parseEther("1"),
                    publicCollateralAmountPre = ethers.utils.parseEther("0.7"),
                    amountToDrain = ethers.utils.parseEther("1.5")

                await setAndDrainCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmountPre,
                    publicCollateralAmountPre,
                    amountToDrain
                )

                const expectedBuffer = ethers.utils.parseEther("0")
                expectCollaterals(
                    insurance,
                    expectedBuffer,
                    publicCollateralAmountPre
                )
            })

            it("drains all of the buffer, and some public while leaving one token", async () => {
                let bufferCollateralAmountPre = ethers.utils.parseEther("1"),
                    publicCollateralAmountPre = ethers.utils.parseEther("1.2"),
                    amountToDrain = ethers.utils.parseEther("1.5")

                await setAndDrainCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmountPre,
                    publicCollateralAmountPre,
                    amountToDrain
                )

                const expectedBuffer = ethers.utils.parseEther("0")
                const expectedPublic = ethers.utils.parseEther("1")
                expectCollaterals(insurance, expectedBuffer, expectedPublic)
            })

            it("drains all of the buffer, and however much it needs from public", async () => {
                let bufferCollateralAmountPre = ethers.utils.parseEther("1"),
                    publicCollateralAmountPre = ethers.utils.parseEther("1.2"),
                    amountToDrain = ethers.utils.parseEther("1.1")

                await setAndDrainCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmountPre,
                    publicCollateralAmountPre,
                    amountToDrain
                )

                const expectedBuffer = ethers.utils.parseEther("0")
                const expectedPublic = ethers.utils.parseEther("1.1")
                expectCollaterals(insurance, expectedBuffer, expectedPublic)
            })

            it("drains part of buffer", async () => {
                let bufferCollateralAmountPre = ethers.utils.parseEther("1.5"),
                    publicCollateralAmountPre = ethers.utils.parseEther("0.5"),
                    amountToDrain = ethers.utils.parseEther("1")

                await setAndDrainCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmountPre,
                    publicCollateralAmountPre,
                    amountToDrain
                )

                const expectedBuffer = ethers.utils.parseEther("0.5")
                expectCollaterals(
                    insurance,
                    expectedBuffer,
                    publicCollateralAmountPre
                )
            })

            it("deposits into the market", async () => {
                // set collateral holdings to 5
                await quoteToken.approve(
                    insurance.address,
                    ethers.utils.parseEther("5")
                )
                await insurance.deposit(ethers.utils.parseEther("5"))

                // try withdraw 1 from the pool
                await insurance.drainPool(ethers.utils.parseEther("1"))
                const balance = await tracer.getBalance(insurance.address)
                expect(balance.position.quote).to.equal(
                    ethers.utils.parseEther("1")
                )
            })

            it("correctly updates the pool's collateral holding", async () => {
                await quoteToken.approve(
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

        context("when called by someone other than liquidation", async () => {
            it("reverts", async () => {
                const accounts = await ethers.getSigners()

                await expect(
                    insurance
                        .connect(accounts[1])
                        .drainPool(ethers.utils.parseEther("1"))
                ).to.be.revertedWith("INS: sender not LIQ contract")
            })
        })
    })

    describe("getPoolTarget", async () => {
        context("when called", async () => {
            it("returns 1% of the markets leveraged notional value", async () => {
                tracer.setLeveragedNotionalValue(ethers.utils.parseEther("100"))
                let poolTarget = await insurance.getPoolTarget()
                expect(poolTarget).to.equal(ethers.utils.parseEther("1"))
            })
        })
    })
})
