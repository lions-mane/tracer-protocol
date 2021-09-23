const { expect } = require("chai")

const expectCollaterals = async (insurance, expectedBuffer, expectedPublic) => {
    const actualBuffer = await insurance.bufferCollateralAmount()
    const actualPublic = await insurance.publicCollateralAmount()
    expect(actualBuffer).to.equal(expectedBuffer)
    expect(actualPublic).to.equal(expectedPublic)
}

const setCollaterals = async (
    mockTracer,
    quoteToken,
    insurance,
    bufferAmount,
    publicAmount
) => {
    await setBufferCollateral(mockTracer, quoteToken, insurance, bufferAmount)
    await setPublicCollateral(quoteToken, insurance, publicAmount)
}

const setBufferCollateral = async (
    mockTracer,
    quoteToken,
    insurance,
    bufferAmount
) => {
    await quoteToken.approve(mockTracer.address, bufferAmount)

    await mockTracer.depositToAccount(insurance.address, bufferAmount)

    await insurance.updatePoolAmount()
}

const setPublicCollateral = async (quoteToken, insurance, publicAmount) => {
    await quoteToken.approve(insurance.address, publicAmount)

    await insurance.deposit(publicAmount)
}

const setAndDrainCollaterals = async (
    mockTracer,
    quoteToken,
    insurance,
    bufferAmount,
    publicAmount,
    amountToDrain
) => {
    await setCollaterals(
        mockTracer,
        quoteToken,
        insurance,
        bufferAmount,
        publicAmount
    )

    await insurance.drainPool(amountToDrain)
}

module.exports = {
    expectCollaterals,
    setCollaterals,
    setAndDrainCollaterals,
}
