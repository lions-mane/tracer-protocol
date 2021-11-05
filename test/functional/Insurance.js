const { expect } = require("chai")
const { ethers, deployments } = require("hardhat")
const { BigNumber } = require("ethers")
const {
    getInsurance,
    getMockTracer,
    getQuoteToken,
    getPoolToken,
} = require("../util/DeploymentUtil")

const oneDay = 24 * 60 * 60
const sixDays = 6 * oneDay
const fifteenDays = 15 * 24 * 60 * 60

const forwardTime = async (seconds) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine", [])
}

const setupTests = deployments.createFixture(async () => {
    await deployments.fixture(["GetIntoLiquidatablePosition"])
    tracer = await getMockTracer()
    insurance = await getInsurance(tracer)
    poolToken = await getPoolToken(insurance)

    // set liquidation contract to accounts[4]
    accounts = await ethers.getSigners()
    tracer.setLiquidationContract(accounts[4].address)

    return {
        insurance: insurance,
        poolToken: poolToken,
        quoteToken: await getQuoteToken(tracer),
    }
})

describe("Insurance functional tests", async () => {
    let accounts, liquidation

    before(async function () {
        accounts = await ethers.getSigners()
        liquidation = accounts[4]
    })

    context("getPoolHoldingsWithPending", async () => {
        context("When pending < holding", async () => {
            it("returns holdings less pending withdrawals", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )

                await insurance.deposit(ethers.utils.parseEther("100"))

                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("55"),
                    "0"
                )

                await insurance.scanDelayedWithdrawals(
                    ethers.utils.parseEther("55")
                )

                const poolHoldings = await insurance.getPoolHoldings()
                const poolWithdrawals =
                    await insurance.totalPendingCollateralWithdrawals()

                const expectedHoldings = poolHoldings.sub(poolWithdrawals)

                expect(await insurance.getPoolHoldingsWithPending()).to.equal(
                    expectedHoldings
                )
            })
        })

        context("When pending > holding", async () => {
            it("returns 0 ", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )

                await insurance.deposit(ethers.utils.parseEther("100"))

                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("100"),
                    "0"
                )

                await insurance.scanDelayedWithdrawals(
                    ethers.utils.parseEther("100")
                )

                await insurance
                    .connect(liquidation)
                    .drainPool(ethers.utils.parseEther("50"))

                expect(await insurance.getPoolHoldingsWithPending()).to.equal(0)
            })
        })
    })

    context("commitToDelayedWithdrawal", async () => {
        context("When balance < amount", async () => {
            it("Reverts ", async () => {
                const { quoteToken, insurance } = await setupTests()
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance
                    .connect(accounts[0])
                    .deposit(ethers.utils.parseEther("100"))
                const tx = insurance
                    .connect(accounts[0])
                    .commitToDelayedWithdrawal(
                        ethers.utils.parseEther("10000"),
                        "0"
                    )
                await expect(tx).to.be.revertedWith("INS: balance < amount")
            })
        })
        context("When a withdrawal is already pending", async () => {
            it("Deletes old one ", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance.deposit(ethers.utils.parseEther("1000"))
                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("100"),
                    "0"
                )

                // Second commit
                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("50"),
                    "0"
                )

                const pending =
                    await insurance.totalPendingCollateralWithdrawals()

                expect(pending).to.equal(ethers.utils.parseEther("50"))
            })
        })

        context("Committing to valid delayed withdrawal", async () => {
            it("Pays fees, updates pending amount", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )

                await insurance.deposit(ethers.utils.parseEther("100"))
                const publicBalanceBefore =
                    await insurance.publicCollateralAmount()
                const bufferBalanceBefore =
                    await insurance.bufferCollateralAmount()
                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("55"),
                    "0"
                )

                await insurance.scanDelayedWithdrawals(
                    ethers.utils.parseEther("55")
                )

                // target is 180, pool holdings will drop to 45, meaning pool will be 45/180 = 25%
                // Fee = 0.2*(1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                //     = 0.2 * (1 - 0.25) ^ 2 * 55
                //     = 0.2 * 0.75^2 * 55 = 0.2 * 30.9375 = 6.1875
                const fee = ethers.utils.parseEther("6.1875")

                // Pays fees
                const publicBalanceAfter =
                    await insurance.publicCollateralAmount()
                const bufferBalanceAfter =
                    await insurance.bufferCollateralAmount()
                expect(publicBalanceAfter).to.equal(
                    publicBalanceBefore.sub(fee)
                )
                expect(bufferBalanceAfter).to.equal(
                    bufferBalanceBefore.add(fee)
                )

                // Updates pending amount
                const pending =
                    await insurance.totalPendingCollateralWithdrawals()
                // Pending should be the withdrawal amount minus the fee paid
                const expectedPending = ethers.utils.parseEther("55").sub(fee)
                expect(pending).to.equal(expectedPending)
            })
        })

        context("Committing after another commit has been made", async () => {
            it("Calculates fee based on pending amount from first commit", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await quoteToken
                    .connect(accounts[1])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance.deposit(ethers.utils.parseEther("50"))
                await insurance
                    .connect(accounts[1])
                    .deposit(ethers.utils.parseEther("50"))
                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("10"),
                    "0"
                )

                // target is 180, pool holdings will drop to 90, meaning pool will be 90/180 = 50%
                // Fee = 0.2*(1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                //     = 0.2 * (1 - 0.5) ^ 2 * 10
                //     = 0.2 * 0.5^2 * 10 = 0.2 * 2.5 = 0.5
                const fee = ethers.utils.parseEther("0.5")
                // Pending should be the withdrawal amount minus the fee paid
                const expectedPending = ethers.utils.parseEther("10").sub(fee)
                const pending =
                    await insurance.totalPendingCollateralWithdrawals()
                expect(pending).to.equal(expectedPending)

                const publicBalanceBefore =
                    await insurance.publicCollateralAmount()
                const bufferBalanceBefore =
                    await insurance.bufferCollateralAmount()

                await insurance
                    .connect(accounts[1])
                    .commitToDelayedWithdrawal(
                        ethers.utils.parseEther("10"),
                        "0"
                    )

                // The change in collateral becomes 9.95 because the ratio changed as a result of the first commit
                // 100 - (99.5/100) * 10 = 9.95
                // target is 180, pool holdings will drop to 80.55, meaning pool will be 80.55/180 = 0.444722222%
                // Fee = 0.2*(1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                //     = 0.2 * (1 - 80.55/180) ^ 2 * 9.95 = 0.607459937
                const fee2 = ethers.utils.parseEther("0.6074599375") // exact amount

                // Pays fees
                const publicBalanceAfter =
                    await insurance.publicCollateralAmount()
                const bufferBalanceAfter =
                    await insurance.bufferCollateralAmount()
                expect(publicBalanceAfter).to.equal(
                    publicBalanceBefore.sub(fee2)
                )
                expect(bufferBalanceAfter).to.equal(
                    bufferBalanceBefore.add(fee2)
                )

                // Updates pending amount
                // Pending amount should be the amount we added, plus the amount from first commit
                const expectedPending2 = ethers.utils
                    .parseEther("9.95")
                    .sub(fee2)
                    .add(expectedPending)
                const pendingAfter =
                    await insurance.totalPendingCollateralWithdrawals()
                expect(pendingAfter).to.equal(expectedPending2)
            })
        })

        context("Committing after another has expired", async () => {
            it("Deletes old one, pays fees, updates pending amount", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await quoteToken
                    .connect(accounts[1])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance.deposit(ethers.utils.parseEther("50"))
                await insurance
                    .connect(accounts[1])
                    .deposit(ethers.utils.parseEther("50"))
                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("10"),
                    "0"
                )
                // Skip forward 15 days, so the first one is expired
                await forwardTime(fifteenDays)

                // target is 180, pool holdings will drop to 90, meaning pool will be 90/180 = 50%
                // Fee = 0.2*(1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                //     = 0.2 * (1 - 0.5) ^ 2 * 10
                //     = 0.2 * 0.5^2 * 10 = 0.2 * 2.5 = 0.5
                const fee = ethers.utils.parseEther("0.5")
                // Pending should be the withdrawal amount minus the fee paid
                const expectedPending = ethers.utils.parseEther("10").sub(fee)
                const pending =
                    await insurance.totalPendingCollateralWithdrawals()
                expect(pending).to.equal(expectedPending)

                const publicBalanceBefore =
                    await insurance.publicCollateralAmount()
                const bufferBalanceBefore =
                    await insurance.bufferCollateralAmount()

                await insurance
                    .connect(accounts[1])
                    .commitToDelayedWithdrawal(
                        ethers.utils.parseEther("10"),
                        "0"
                    )

                // The change in collateral becomes 9.95 because the ratio changed as a result of the first commit
                // 100 - (99.5/100) * 10 = 9.95
                // target is 180, pool holdings will drop to 90.05, meaning pool will be 90.05/180 = 0.500277778%
                // Fee = 0.2*(1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                //     = 0.2 * (1 - 0.500277778) ^ 2 * 9.95
                //     = 0.2 * 0.5^2 * 10 = 0.2 * 2.5 = 0.496947376
                const fee2 = ethers.utils.parseEther("0.496947375771604939") // exact amount

                // Pays fees
                const publicBalanceAfter =
                    await insurance.publicCollateralAmount()
                const bufferBalanceAfter =
                    await insurance.bufferCollateralAmount()
                expect(publicBalanceAfter).to.equal(
                    publicBalanceBefore.sub(fee2)
                )
                expect(bufferBalanceAfter).to.equal(
                    bufferBalanceBefore.add(fee2)
                )

                // Updates pending amount
                const expectedPending2 = ethers.utils
                    .parseEther("9.95")
                    .sub(fee2)
                const pendingAfter =
                    await insurance.totalPendingCollateralWithdrawals()
                expect(pendingAfter).to.equal(expectedPending2)
            })
        })

        context("Committing after another has been executed", async () => {
            it("Deletes old one, pays fees, updates pending amount", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await quoteToken
                    .connect(accounts[1])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance.deposit(ethers.utils.parseEther("50"))
                await insurance
                    .connect(accounts[1])
                    .deposit(ethers.utils.parseEther("50"))
                await insurance.commitToDelayedWithdrawal(
                    ethers.utils.parseEther("10"),
                    "0"
                )
                // Skip forward 6 days, so the first one is able to be executed
                await forwardTime(sixDays)
                await insurance.executeDelayedWithdrawal("0")
                const publicBalanceBefore =
                    await insurance.publicCollateralAmount()
                const bufferBalanceBefore =
                    await insurance.bufferCollateralAmount()

                await insurance
                    .connect(accounts[1])
                    .commitToDelayedWithdrawal(
                        ethers.utils.parseEther("10"),
                        "0"
                    )

                // 90.05 - (89.55/90) * 10 = 80.1
                // target is 180, pool holdings will drop to 80.1, meaning pool will be 80.1/180 = 0.445%
                // Fee = 0.2*(1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                //     = 0.2 * (1 - 80.1/180) ^ 2 * 9.95 = 0.61296975
                const fee2 = ethers.utils.parseEther("0.61296975") // exact amount

                // Pays fees
                const publicBalanceAfter =
                    await insurance.publicCollateralAmount()
                const bufferBalanceAfter =
                    await insurance.bufferCollateralAmount()
                expect(publicBalanceAfter).to.equal(
                    publicBalanceBefore.sub(fee2)
                )

                expect(bufferBalanceAfter).to.equal(
                    bufferBalanceBefore.add(fee2)
                )

                // Updates pending amount
                const expectedPending2 = ethers.utils
                    .parseEther("9.95")
                    .sub(fee2)
                const pendingAfter =
                    await insurance.totalPendingCollateralWithdrawals()
                expect(pendingAfter).to.equal(expectedPending2)
            })
        })
    })

    context("executeDelayedWithdrawal", async () => {
        context("When delay has not passed", async () => {
            it("Reverts ", async () => {
                const { quoteToken, insurance } = await setupTests()
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance
                    .connect(accounts[0])
                    .deposit(ethers.utils.parseEther("100"))
                await insurance
                    .connect(accounts[0])
                    .commitToDelayedWithdrawal(
                        ethers.utils.parseEther("100"),
                        "0"
                    )

                const tx = insurance
                    .connect(accounts[0])
                    .executeDelayedWithdrawal("0")

                await expect(tx).to.be.revertedWith(
                    "INS: Withdrawal still pending"
                )
            })
        })

        context("When not comitted", async () => {
            it("Reverts ", async () => {
                const { insurance } = await setupTests()

                const tx = insurance
                    .connect(accounts[0])
                    .executeDelayedWithdrawal("0")

                await expect(tx).to.be.revertedWith(
                    "INS: No withdrawal pending"
                )
            })
        })

        context("When Expired", async () => {
            it("Reverts", async () => {
                const { quoteToken, insurance } = await setupTests()
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance
                    .connect(accounts[0])
                    .deposit(ethers.utils.parseEther("100"))
                await insurance
                    .connect(accounts[0])
                    .commitToDelayedWithdrawal(
                        ethers.utils.parseEther("100"),
                        "0"
                    )

                await forwardTime(fifteenDays)

                const tx = insurance
                    .connect(accounts[0])
                    .executeDelayedWithdrawal("0")

                // No withdrawal pending, because we cleared it at start of `executeDelayedWithdrawal`
                await expect(tx).to.be.revertedWith(
                    "INS: No withdrawal pending"
                )
            })
        })

        context("When executed", async () => {
            it("Reverts", async () => {
                const { quoteToken, insurance } = await setupTests()
                await quoteToken
                    .connect(accounts[0])
                    .approve(
                        insurance.address,
                        ethers.utils.parseEther("99999999")
                    )
                await insurance
                    .connect(accounts[0])
                    .deposit(ethers.utils.parseEther("100"))
                await insurance
                    .connect(accounts[0])
                    .commitToDelayedWithdrawal(
                        ethers.utils.parseEther("100"),
                        "0"
                    )

                await forwardTime(sixDays)

                await insurance
                    .connect(accounts[0])
                    .executeDelayedWithdrawal("0")
                const tx = insurance
                    .connect(accounts[0])
                    .executeDelayedWithdrawal("0")

                await expect(tx).to.be.revertedWith(
                    "INS: No withdrawal pending"
                )
            })
        })

        context(
            "When you commit, instant withdraw, then try to execute delayed withdrawal",
            async () => {
                it("delayed withdrawal should not exist", async () => {
                    const { quoteToken, insurance } = await setupTests()
                    await quoteToken
                        .connect(accounts[0])
                        .approve(
                            insurance.address,
                            ethers.utils.parseEther("99999999")
                        )
                    await insurance
                        .connect(accounts[0])
                        .deposit(ethers.utils.parseEther("100"))
                    await insurance
                        .connect(accounts[0])
                        .commitToDelayedWithdrawal(
                            ethers.utils.parseEther("100"),
                            "0"
                        )

                    await forwardTime(sixDays)

                    await insurance
                        .connect(accounts[0])
                        .withdraw(ethers.utils.parseEther("50"))
                    const tx = insurance
                        .connect(accounts[0])
                        .executeDelayedWithdrawal("0")

                    await expect(tx).to.be.revertedWith(
                        "INS: No withdrawal pending"
                    )
                })
            }
        )

        context(
            "When you commit, wait, then execute delayed withdrawal",
            async () => {
                it("Operates as normal", async () => {
                    let { quoteToken, insurance } = await setupTests()
                    insurance = insurance.connect(accounts[0])
                    await quoteToken
                        .connect(accounts[0])
                        .approve(
                            insurance.address,
                            ethers.utils.parseEther("99999999")
                        )
                    await insurance.deposit(ethers.utils.parseEther("100"))
                    const bufferCollatBefore =
                        await insurance.bufferCollateralAmount()
                    await insurance.commitToDelayedWithdrawal(
                        ethers.utils.parseEther("100"),
                        "0"
                    )

                    // target is 180, pool holdings will drop to 0 = 0%
                    // Fee = 0.2 * (1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                    //     = 0.2 * (1 - 0) ^ 2 * 100 = 0.2*100 = 20
                    const expectedFee = ethers.utils.parseEther("20")

                    await forwardTime(sixDays)
                    const balanceBefore = await quoteToken
                        .connect(accounts[0])
                        .balanceOf(accounts[0].address)

                    await insurance.executeDelayedWithdrawal("0")

                    const withdrawalId =
                        await insurance.accountsDelayedWithdrawal(
                            accounts[0].address
                        )
                    const pending =
                        await insurance.totalPendingCollateralWithdrawals()
                    const poolTokenAfter = await insurance.getPoolUserBalance(
                        accounts[0].address
                    )
                    const bufferCollatAfter =
                        await insurance.bufferCollateralAmount()
                    const balanceAfter = await quoteToken
                        .connect(accounts[0])
                        .balanceOf(accounts[0].address)

                    // ID should be 0, which means none set (i.e. it got deleted)
                    expect(withdrawalId).to.equal("0")
                    // Pending being 0 means delayed withdrawal was removed
                    expect(pending).to.equal("0")
                    // Buffer amount should increase by fee amount
                    expect(bufferCollatAfter).to.equal(
                        bufferCollatBefore.add(expectedFee)
                    )
                    expect(poolTokenAfter).to.equal("0")

                    // public = 100 - 20 = 80
                    // withdrawal = 80/100 * 100 = 80
                    expect(balanceAfter).to.equal(
                        balanceBefore.add(ethers.utils.parseEther("80"))
                    )
                })
            }
        )
    })

    context("withdraw", async () => {
        context("When delay is pending", async () => {
            it("Deletes delayed withdrawal", async () => {
                let { quoteToken, insurance } = await setupTests()
                insurance = insurance.connect(accounts[0])
                const depositAmount = ethers.utils.parseEther("50")
                const withdrawAmount = ethers.utils.parseEther("10")
                await quoteToken
                    .connect(accounts[0])
                    .approve(insurance.address, depositAmount)
                await insurance.deposit(depositAmount)
                await insurance.commitToDelayedWithdrawal(withdrawAmount, "0")

                const bufferCollatBefore =
                    await insurance.bufferCollateralAmount()
                const balanceBefore = await quoteToken
                    .connect(accounts[0])
                    .balanceOf(accounts[0].address)

                await insurance.withdraw(withdrawAmount)
                const bufferCollatAfter =
                    await insurance.bufferCollateralAmount()
                const withdrawalId = await insurance.accountsDelayedWithdrawal(
                    accounts[0].address
                )

                // wadquoteTokensToSend = (10 - initial delayed fee) / 10 * 10
                //                 = (10 - 0.24197530864) / 10 * 10 = 9.758024691358024690
                // target is 180, pool holdings will drop to (50 - 9.758024691358024690) = 40.241975309, meaning pool will be 40.24/180 = ~22.2222%
                // Fee = (1-(Fund % of target after withdrawal))^2 * collateralWithdrawalAmount
                //     = (1 - (40.24/180)) ^ 2 * 9.75 = 5.882614784344665883
                const expectedFee = ethers.utils.parseEther(
                    "5.882614784344665883"
                )
                const amountWithdrawn = ethers.utils
                    .parseEther("9.758024691358024690")
                    .sub(expectedFee)

                const poolTokenAfter = await insurance.getPoolUserBalance(
                    accounts[0].address
                )
                const pending =
                    await insurance.totalPendingCollateralWithdrawals()
                const balanceAfter = await quoteToken
                    .connect(accounts[0])
                    .balanceOf(accounts[0].address)

                // ID should be 0, which means none set (i.e. it got deleted)
                expect(withdrawalId).to.equal("0")
                // Pending being 0 means delayed withdrawal was removed
                expect(pending).to.equal("0")
                // Buffer amount should increase by fee amount
                expect(bufferCollatAfter).to.equal(
                    bufferCollatBefore.add(expectedFee)
                )
                // Balance should be 50 - 10 = 40
                expect(poolTokenAfter).to.equal(
                    depositAmount.sub(withdrawAmount)
                )

                expect(balanceBefore).to.equal(
                    balanceAfter.sub(amountWithdrawn)
                )
            })
        })
    })

    context("e2e", async () => {
        it("Operates as normal", async () => {
            let { quoteToken, poolToken, insurance } = await setupTests()
            insurance = insurance.connect(accounts[0])
            await quoteToken
                .connect(accounts[0])
                .approve(insurance.address, ethers.utils.parseEther("99999999"))
            await quoteToken
                .connect(accounts[1])
                .approve(insurance.address, ethers.utils.parseEther("99999999"))
            await quoteToken
                .connect(accounts[2])
                .approve(insurance.address, ethers.utils.parseEther("99999999"))
            await quoteToken
                .connect(accounts[3])
                .approve(insurance.address, ethers.utils.parseEther("99999999"))
            await insurance.deposit(ethers.utils.parseEther("100"))
            await insurance
                .connect(accounts[1])
                .deposit(ethers.utils.parseEther("100"))
            await insurance
                .connect(accounts[2])
                .deposit(ethers.utils.parseEther("100"))

            await insurance.commitToDelayedWithdrawal(
                ethers.utils.parseEther("100"),
                "0"
            )

            // target is 180, pool holdings will drop to 200 > 100%
            // Fee = 0
            const expectedFee = ethers.utils.parseEther("0")
            let bufferCollatAfter = await insurance.bufferCollateralAmount()
            expect(bufferCollatAfter).to.equal(expectedFee)
            const pending1 = await insurance.totalPendingCollateralWithdrawals()
            expect(pending1).to.equal(ethers.utils.parseEther("100"))

            await forwardTime(oneDay * 2)
            await insurance
                .connect(accounts[1])
                .commitToDelayedWithdrawal(ethers.utils.parseEther("100"), "0")

            // target is 180, pool holdings will drop to 100.
            // Fee = 0.2 * (1 - 100/180)^2 * 100 = ~3.950617284
            const secondFee = ethers.utils.parseEther("3.950617283950617280")
            bufferCollatAfter = await insurance.bufferCollateralAmount()
            expect(bufferCollatAfter).to.equal(secondFee)

            await insurance
                .connect(accounts[2])
                .withdraw(ethers.utils.parseEther("50"))
            // target is 180, pool holdings will drop to 300 - 100 - (100 - 3.950617283950617280) - 49.341563786 = 54.609053498
            // fee = (1 - 54.609053498/180)^2 *  49.341563786 = 23.944196093
            const thirdFee = ethers.utils.parseEther("23.944196093270293340")
            bufferCollatAfter = await insurance.bufferCollateralAmount()
            expect(bufferCollatAfter).to.equal(secondFee.add(thirdFee))

            await forwardTime(oneDay * 9)
            await insurance
                .connect(accounts[3])
                .deposit(ethers.utils.parseEther("100"))
            const account3poolTokenBalanceAfterDeposit = await poolToken
                .connect(accounts[3])
                .balanceOf(accounts[3].address)
            await insurance
                .connect(accounts[3])
                .commitToDelayedWithdrawal(
                    account3poolTokenBalanceAfterDeposit,
                    "0"
                )

            // quoteToken withdraw amount = 346.707... / 351.33.... * 101.33... = 99.99....
            // fee = 0.2 * (1 - (374.60 - 96.05 - 99.9999) / 180)^2 * 98.68 = ~0.001292
            const fourthFee = ethers.utils.parseEther("0.001292028855139660")

            const tx = insurance.executeDelayedWithdrawal("0")
            await expect(tx).to.be.revertedWith("INS: No withdrawal pending")
            const pending2 = await insurance.totalPendingCollateralWithdrawals()
            // should be 200 - fees, since three commitments have been made, and one has expired
            expect(pending2).to.equal(
                ethers.utils
                    .parseEther("199.999999999999999946")
                    .sub(secondFee)
                    .sub(fourthFee)
            )

            const acc1BalBefore = await quoteToken
                .connect(accounts[1])
                .balanceOf(accounts[1].address)
            const acc3BalBefore = await quoteToken
                .connect(accounts[1])
                .balanceOf(accounts[3].address)
            // At this stage, accounts[3] and accounts[1] have pending withdrawals
            // Execute both withdrawals
            // collat amount = publicCollateralAmount / pool quoteToken supply * 100
            let poolTokenTotalSupply = await insurance.getPoolTokenTotalSupply()
            let publicCollatAmount = await insurance.publicCollateralAmount()
            // 351.33... is the pool quoteToken total supply
            const expectedBalanceDifference1 = publicCollatAmount
                .mul(ethers.utils.parseEther("100"))
                .div(poolTokenTotalSupply)
            await insurance.connect(accounts[1]).executeDelayedWithdrawal("0")

            await forwardTime(sixDays)

            poolTokenTotalSupply = await insurance.getPoolTokenTotalSupply()
            publicCollatAmount = await insurance.publicCollateralAmount()
            // 351.33... is the pool quoteToken total supply
            const expectedBalanceDifference2 = publicCollatAmount
                .mul(account3poolTokenBalanceAfterDeposit)
                .div(poolTokenTotalSupply)
            await insurance.connect(accounts[3]).executeDelayedWithdrawal("0")

            //check
            const pending = await insurance.totalPendingCollateralWithdrawals()
            // All delayed withdrawals are done, pending should be 0
            expect(pending).to.equal("0")
            const acc1BalAfter = await quoteToken
                .connect(accounts[1])
                .balanceOf(accounts[1].address)
            const acc3BalAfter = await quoteToken
                .connect(accounts[1])
                .balanceOf(accounts[3].address)

            await insurance.withdraw(ethers.utils.parseEther("100"))
            // public collat =
            // pool quoteToken =
            await insurance
                .connect(accounts[2])
                .withdraw(ethers.utils.parseEther("50"))
            const fifthFee = BigNumber.from("32163679291602780702")
            const sixthFee = BigNumber.from("21907656815025657037")
            // balances of each
            // For rounding
            const epsilon = BigNumber.from("150")
            expect(acc1BalAfter.sub(acc1BalBefore)).to.be.within(
                expectedBalanceDifference1.sub(epsilon),
                expectedBalanceDifference1.add(epsilon)
            )
            expect(acc3BalAfter.sub(acc3BalBefore)).to.be.within(
                expectedBalanceDifference2.sub(epsilon),
                expectedBalanceDifference2.add(epsilon)
            )
            // getPoolHoldings() == sum of all fees
            const poolHoldings = await insurance.getPoolHoldings()
            const expectedPoolHoldings = secondFee
                .add(thirdFee)
                .add(fourthFee)
                .add(fifthFee)
                .add(sixthFee)
            expect(poolHoldings).to.be.within(
                expectedPoolHoldings.sub(epsilon),
                expectedPoolHoldings.add(epsilon)
            )
        })
    })
})
