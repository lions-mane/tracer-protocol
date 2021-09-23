const { expect } = require("chai")
const { ethers, deployments } = require("hardhat")
const {
    getQuoteToken,
    getInsurance,
    getMockTracer,
} = require("../util/DeploymentUtil")
const { setCollaterals } = require("../util/InsuranceUtil")

const FUNDING_RATE_FACTOR = ethers.utils.parseEther("0.00000570775")

const setupTests = deployments.createFixture(async () => {
    await deployments.fixture(["MockTracerDeploy"])
    tracer = await getMockTracer()

    return {
        tracer: tracer,
        quoteToken: await getQuoteToken(tracer),
        insurance: await getInsurance(tracer),
    }
})

describe("Unit tests: Insurance.sol", function () {
    let tracer
    let quoteToken
    let insurance

    beforeEach(async function () {
        ;({ tracer, quoteToken, insurance } = await setupTests())
    })

    describe("getPoolFundingRate", async () => {
        context("when the leveraged notional value is <= 0", async () => {
            it("returns 0", async () => {
                // set leveraged notional value to 0
                await tracer.setLeveragedNotionalValue(0)

                let poolFundingRate = await insurance.getPoolFundingRate()
                expect(poolFundingRate).to.equal(0)
            })
        })

        context("when the pool is greater than the target", async () => {
            it("returns 0", async () => {
                // set leveraged notional value to 100
                await tracer.setLeveragedNotionalValue(
                    ethers.utils.parseEther("100")
                )

                let bufferCollateralAmount = ethers.utils.parseEther("100")
                let publicCollateralAmount = ethers.utils.parseEther("100")

                await setCollaterals(
                    tracer,
                    quoteToken,
                    insurance,
                    bufferCollateralAmount,
                    publicCollateralAmount
                )

                let poolFundingRate = await insurance.getPoolFundingRate()
                // poolFundingRate = constant * ratio
                //                 = ((fund_target - fund_holdings)/fund_holdings) ** 2
                let ratio = ethers.utils.parseEther("0")
                let expectedFundingRate = FUNDING_RATE_FACTOR.mul(ratio)
                    .mul(ratio)
                    .div(ethers.utils.parseEther("1")) //divide by 1 to simulate WAD math division
                expect(poolFundingRate).to.equal(expectedFundingRate)
            })
        })

        context(
            "when the leveraged notional value is > 0 and the pool is empty",
            async () => {
                it("returns the appropriate one hour funding rate", async () => {
                    // set leveraged notional value to 400
                    await tracer.setLeveragedNotionalValue(
                        ethers.utils.parseEther("400")
                    )

                    let bufferCollateralAmount = ethers.utils.parseEther("0")
                    let publicCollateralAmount = ethers.utils.parseEther("0")

                    await setCollaterals(
                        tracer,
                        quoteToken,
                        insurance,
                        bufferCollateralAmount,
                        publicCollateralAmount
                    )

                    let poolFundingRate = await insurance.getPoolFundingRate()
                    // poolFundingRate = constant * (ratio ** 2)
                    //                 = constant * (((fund_target - fund_holdings)/fund_target) ** 2)
                    //                 = constant * (((4 - 0)/4) ** 2)
                    //                 = constant * 1
                    let ratio = ethers.utils.parseEther("1")
                    let expectedFundingRate = FUNDING_RATE_FACTOR.mul(
                        ratio
                    ).div(ethers.utils.parseEther("1")) // should be 0.000570775%
                    expect(expectedFundingRate).to.equal(
                        ethers.utils.parseEther("0.00000570775")
                    )

                    expect(poolFundingRate).to.equal(expectedFundingRate)
                })
            }
        )

        context(
            "when the leveraged notional value is > 0 and the pool is not empty",
            async () => {
                it("returns the appropriate one hour funding rate", async () => {
                    // set leveraged notional value to 400
                    await tracer.setLeveragedNotionalValue(
                        ethers.utils.parseEther("400")
                    )

                    let bufferCollateralAmount = ethers.utils.parseEther("1")
                    let publicCollateralAmount = ethers.utils.parseEther("1")

                    await setCollaterals(
                        tracer,
                        quoteToken,
                        insurance,
                        bufferCollateralAmount,
                        publicCollateralAmount
                    )

                    let poolFundingRate = await insurance.getPoolFundingRate()
                    // poolFundingRate = constant * (ratio ** 2)
                    //                 = constant * (((fund_target - fund_holdings)/fund_target) ** 2)
                    //                 = constant * (((4 - 2)/4) ** 2)
                    //                 = constant * (0.5 ** 2) = constant * 0.25
                    let ratio = ethers.utils.parseEther("0.25")
                    let expectedFundingRate = FUNDING_RATE_FACTOR.mul(
                        ratio
                    ).div(ethers.utils.parseEther("1")) // should be 0.000142694063926941%
                    expect(expectedFundingRate).to.equal(
                        ethers.utils.parseEther("0.0000014269375") // Approximate due to imprecision
                    )

                    expect(poolFundingRate).to.equal(expectedFundingRate)
                })
            }
        )
    })
})
