// Executes a successful trade at a specified price and amount.
// Uses account 1 as the long maker and account 2 as the short maker by default.
const executeTrade = async (
    tracer,
    trader,
    price,
    amount,
    longMaker,
    shortMaker
) => {
    const long = createOrder(tracer, price, amount, true, longMaker)
    const short = createOrder(tracer, price, amount, false, shortMaker)
    let tx = await matchOrders(trader, long, short)
    return tx
}

// Returns an order object with specified attributes. Unspecified attributes are set to valid default values.
// Must provide the deployment fixture, price, amount, side and maker
const createOrder = (
    _tracer,
    _price,
    _amount,
    _isLong,
    _maker,
    _expires = 3621988237,
    _created = 0
) => {
    return {
        maker: _maker,
        market: _tracer.address,
        price: _price,
        amount: _amount,
        side: _isLong ? 0 : 1, // long = 0, short = 1
        expires: _expires,
        created: _created,
    }
}

// matches two orders
const matchOrders = async (trader, order1, order2) => {
    const mockSignedOrder1 = [
        order1,
        ethers.utils.formatBytes32String("DummyString"),
        ethers.utils.formatBytes32String("DummyString"),
        0,
    ]

    const mockSignedOrder2 = [
        order2,
        ethers.utils.formatBytes32String("DummyString"),
        ethers.utils.formatBytes32String("DummyString"),
        0,
    ]

    // place trades
    let tx = await trader.executeTrade([mockSignedOrder1], [mockSignedOrder2])
    await trader.clearFilled(mockSignedOrder1)
    await trader.clearFilled(mockSignedOrder2)
    return tx
}

const depositQuoteTokens = async (tracer, quoteToken, accounts, amount) => {
    for (var i = 0; i < accounts.length; i++) {
        await quoteToken.transfer(accounts[i].address, amount)

        await quoteToken.connect(accounts[i]).approve(tracer.address, amount)
        await tracer.connect(accounts[i]).deposit(amount)
    }
}

// sets the latest answer of the gas oracle (fGas / USD)
const setGasPrice = async (gasEthOracle, gasPrice) => {
    // fgas/USD = fgas/ETH * ETH/USD
    // ETH/USD = fgas/USD / fgas/ETH
    // mock fgas/ETH node always returns 20 GWEI
    const ethOraclePrice = gasPrice / 0.00000002
    await gasEthOracle.setPrice(ethOraclePrice * 10 ** 8)
}

module.exports = {
    depositQuoteTokens,
    executeTrade,
    createOrder,
    matchOrders,
    setGasPrice,
}
