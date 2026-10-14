// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title MissionPolicyEnforcer
 * @notice Custom caveat enforcer for the SWARM TAB research mission.
 *
 * The official MetaMask delegation framework ships per-scope enforcers, but
 * none of them can express "the recipient of `transfer(address,uint256)` must
 * be one of N allowed addresses" (AND semantics between caveats cannot model
 * an OR allow-list) and none of them enforce a *per-call* cap independent of
 * the cumulative per-delegation cap. This enforcer covers both.
 *
 * Terms encoding (128 bytes):
 *   abi.encode(address token, address recipient0, address recipient1, uint256 maxAmountPerCall)
 *
 * Behaviour (single/default execution only):
 *   - the execution target must be exactly `token`;
 *   - the call data must be exactly `transfer(address,uint256)` (68 bytes);
 *   - the decoded recipient must be `recipient0` or `recipient1`;
 *   - the decoded amount must be <= `maxAmountPerCall`.
 *
 * The cumulative mission budget itself is enforced by the official
 * ERC20TransferAmountEnforcer installed on the same root delegation, whose
 * `spentMap` is keyed by the delegation hash (so it survives new child
 * delegations created from the same root).
 *
 * ERC-7579 single execution calldata layout (as decoded by the framework's
 * ExecutionLib): `target (20 bytes) || value (32 bytes) || callData`.
 *
 * Reference implementation of the hook interface:
 * MetaMask delegation-framework v1.3.0, `src/interfaces/ICaveatEnforcer.sol`.
 */
interface ICaveatEnforcer {
    function beforeAllHook(
        bytes calldata _terms,
        bytes calldata _args,
        bytes32 _mode,
        bytes calldata _executionCalldata,
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    )
        external;

    function beforeHook(
        bytes calldata _terms,
        bytes calldata _args,
        bytes32 _mode,
        bytes calldata _executionCalldata,
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    )
        external;

    function afterHook(
        bytes calldata _terms,
        bytes calldata _args,
        bytes32 _mode,
        bytes calldata _executionCalldata,
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    )
        external;

    function afterAllHook(
        bytes calldata _terms,
        bytes calldata _args,
        bytes32 _mode,
        bytes calldata _executionCalldata,
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    )
        external;
}

contract MissionPolicyEnforcer is ICaveatEnforcer {
    /// @dev ERC-7579 call types / execution types used by the framework.
    uint8 private constant CALLTYPE_SINGLE = 0x00;
    uint8 private constant EXECTYPE_DEFAULT = 0x00;

    bytes4 private constant TRANSFER_SELECTOR = 0xa9059cbb; // transfer(address,uint256)
    uint256 private constant TRANSFER_CALLDATA_LENGTH = 68;
    uint256 private constant EXECUTION_HEADER_LENGTH = 52; // target (20) + value (32)

    error MissionPolicyEnforcerInvalidTermsLength(uint256 length);
    error MissionPolicyEnforcerInvalidCallType(uint8 callType);
    error MissionPolicyEnforcerInvalidExecutionType(uint8 execType);
    error MissionPolicyEnforcerInvalidExecutionLength(uint256 length);
    error MissionPolicyEnforcerInvalidTarget(address target, address expected);
    error MissionPolicyEnforcerInvalidMethod(bytes4 selector);
    error MissionPolicyEnforcerRecipientNotAllowed(address recipient);
    error MissionPolicyEnforcerPerCallCapExceeded(uint256 amount, uint256 maxAmountPerCall);

    /// @inheritdoc ICaveatEnforcer
    function beforeAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external {}

    /// @inheritdoc ICaveatEnforcer
    function beforeHook(
        bytes calldata _terms,
        bytes calldata,
        bytes32 _mode,
        bytes calldata _executionCalldata,
        bytes32,
        address,
        address
    )
        external
        pure
    {
        uint8 callType = uint8(_mode[0]);
        uint8 execType = uint8(_mode[1]);
        if (callType != CALLTYPE_SINGLE) {
            revert MissionPolicyEnforcerInvalidCallType(callType);
        }
        if (execType != EXECTYPE_DEFAULT) {
            revert MissionPolicyEnforcerInvalidExecutionType(execType);
        }

        if (_terms.length != 128) {
            revert MissionPolicyEnforcerInvalidTermsLength(_terms.length);
        }
        (address token, address recipient0, address recipient1, uint256 maxAmountPerCall) =
            abi.decode(_terms, (address, address, address, uint256));

        if (_executionCalldata.length != EXECUTION_HEADER_LENGTH + TRANSFER_CALLDATA_LENGTH) {
            revert MissionPolicyEnforcerInvalidExecutionLength(_executionCalldata.length);
        }
        address target = address(bytes20(_executionCalldata[0:20]));
        if (target != token) {
            revert MissionPolicyEnforcerInvalidTarget(target, token);
        }

        bytes calldata callData = _executionCalldata[EXECUTION_HEADER_LENGTH:];
        bytes4 selector = bytes4(callData[0:4]);
        if (selector != TRANSFER_SELECTOR) {
            revert MissionPolicyEnforcerInvalidMethod(selector);
        }
        address recipient = address(uint160(uint256(bytes32(callData[4:36]))));
        uint256 amount = uint256(bytes32(callData[36:68]));

        if (recipient != recipient0 && recipient != recipient1) {
            revert MissionPolicyEnforcerRecipientNotAllowed(recipient);
        }
        if (amount > maxAmountPerCall) {
            revert MissionPolicyEnforcerPerCallCapExceeded(amount, maxAmountPerCall);
        }
    }

    /// @inheritdoc ICaveatEnforcer
    function afterHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external {}

    /// @inheritdoc ICaveatEnforcer
    function afterAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external {}
}
