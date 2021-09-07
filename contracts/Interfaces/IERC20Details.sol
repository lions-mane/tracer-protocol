//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.4;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC20Details is IERC20 {
    function decimals() external view returns (uint256);
}
