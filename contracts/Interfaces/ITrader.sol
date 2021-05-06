//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;
import "./Types.sol";

interface ITrader {
    function chainId() external view returns (uint256);
    function EIP712_DOMAIN() external view returns (bytes32);

    function executeTrade(
        Types.SignedLimitOrder[] memory makers,
        Types.SignedLimitOrder[] memory takers,
        address market
    ) external;

    function hashOrder(Perpetuals.Order memory order) external view returns (bytes32);

    function getDomain() external view returns (bytes32);

    function verify(
        address signer,
        Types.SignedLimitOrder memory order
    ) external view returns (bool);

    function verifySignature(
        address signer,
        Perpetuals.Order memory order,
        bytes32 sigR,
        bytes32 sigS,
        uint8 sigV
    ) external view returns (bool);

    function verifyNonce(Types.SignedLimitOrder memory order) external view returns (bool);

    function getOrder(Perpetuals.Order memory order) external view returns (Perpetuals.Order memory);

    function filledAmount(Perpetuals.Order memory order) external view returns (uint256);
}
