const oracleAbi = require("../abi/contracts/oracle/Oracle.sol/Oracle.json")
const hre = require("hardhat")
const fs = require("fs")

// Address of the oracle to call `setPrice(...)` on
const ORACLE_ADDRESS = "0xf051bCd20F02deF359cE8aA03a9e4C38b6a55a7c"
const PRICE = "96000000"
const PRIVATE_KEY_FILE = "pkey2.secret"

async function main() {
    // deploy all contracts using hardhat deploy
    const { ethers } = hre

    // Get private key from pkey2.secret, and trim any newlines
    let pkey = fs.readFileSync(PRIVATE_KEY_FILE, "utf-8")
    pkey = pkey.trim()

    // Create wallet with this private key, on kovan
    const wallet = new ethers.Wallet(pkey, ethers.getDefaultProvider("kovan"))

    // Set price to $0.96
    let oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi)
    await oracle.connect(wallet).setPrice(PRICE)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })
