import { decodeErrorResult, parseAbi, type Address, type Hex } from "viem";
import type { Delegation } from "@metamask/smart-accounts-kit";
import { InfrastructureError, PolicyError } from "@/shared/errors";
import type { PaymentErrorKind } from "@/shared/types";
import type { BoundWalletClient, ReadClient } from "./clients";
import { encodeRedeemPayment } from "./permissions";
import { readDelegationSpent } from "./spend";

/** Error fragments of the custom enforcer, used to decode raw revert data. */
export const MISSION_POLICY_ENFORCER_ABI = parseAbi([
  "error MissionPolicyEnforcerInvalidTermsLength(uint256 length)",
  "error MissionPolicyEnforcerInvalidCallType(uint8 callType)",
  "error MissionPolicyEnforcerInvalidExecutionType(uint8 execType)",
  "error MissionPolicyEnforcerInvalidExecutionLength(uint256 length)",
  "error MissionPolicyEnforcerInvalidTarget(address target, address expected)",
  "error MissionPolicyEnforcerInvalidMethod(bytes4 selector)",
  "error MissionPolicyEnforcerRecipientNotAllowed(address recipient)",
  "error MissionPolicyEnforcerPerCallCapExceeded(uint256 amount, uint256 maxAmountPerCall)",
]);

/** Error fragments of the framework's DelegationManager (v1.3.0). */
export const DELEGATION_MANAGER_ERRORS = parseAbi([
  "error InvalidDelegator()",
  "error AlreadyDisabled()",
  "error AlreadyEnabled()",
  "error BatchDataLengthMismatch()",
  "error InvalidDelegate()",
  "error InvalidEOASignature()",
  "error InvalidERC1271Signature()",
  "error InvalidAuthority()",
  "error CannotUseADisabledDelegation()",
]);

const DECODABLE_ERROR_ABIS = [
  MISSION_POLICY_ENFORCER_ABI,
  DELEGATION_MANAGER_ERRORS,
] as const;

/** Revert signatures that mean "the delegation policy refused this payment". */
const POLICY_PATTERNS: readonly RegExp[] = [
  /allowance-exceeded/i,
  /MissionPolicyEnforcer/,
  /TimestampEnforcer/,
  /LimitedCallsEnforcer/,
  /CannotUseADisabledDelegation/,
  /InvalidAuthority/,
  /InvalidDelegate/,
  /InvalidEOASignature/,
  /InvalidERC1271Signature/,
  /invalid-delegation/,
];

function decodeCustomError(data: string): string | null {
  if (!data.startsWith("0x") || data.length < 10) return null;
  for (const abi of DECODABLE_ERROR_ABIS) {
    try {
      const { errorName } = decodeErrorResult({
        abi,
        data: data as Hex,
      });
      return errorName;
    } catch {
      // try the next ABI
    }
  }
  return null;
}

/** Collects human-readable text from viem's nested error objects. */
export function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const decoded = new Set<string>();
  const seen = new Set<unknown>();
  let current: unknown = error;
  let fallback = "";
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record["shortMessage"] === "string" && record["shortMessage"]) {
      parts.push(record["shortMessage"] as string);
    }
    if (typeof record["details"] === "string" && record["details"]) {
      parts.push(record["details"] as string);
    }
    if (typeof record["message"] === "string" && record["message"]) {
      if (!fallback) fallback = record["message"] as string;
    }
    if (typeof record["data"] === "string") {
      const name = decodeCustomError(record["data"]);
      if (name) decoded.add(name);
      else parts.push(record["data"]);
    }
    current = record["cause"];
  }
  if (parts.length === 0) parts.push(fallback || String(error));
  const text = [...new Set(parts)].join(" | ");
  // viem often prints raw revert selectors inside messages; decode any that
  // match known framework errors so classification does not depend on luck.
  for (const match of text.match(/0x[0-9a-fA-F]+/g) ?? []) {
    const name = decodeCustomError(match);
    if (name) decoded.add(name);
  }
  const summary = [text, ...decoded].join(" | ");
  return summary.length > 400 ? `${summary.slice(0, 397)}...` : summary;
}

export function classifyPaymentError(error: unknown): {
  kind: PaymentErrorKind;
  reason: string;
} {
  const reason = collectErrorText(error);
  const kind = POLICY_PATTERNS.some((pattern) => pattern.test(reason))
    ? "policy"
    : "infrastructure";
  return { kind, reason };
}

/** Converts any thrown value into a PolicyError or InfrastructureError. */
export function toPaymentError(error: unknown): PolicyError | InfrastructureError {
  if (error instanceof PolicyError || error instanceof InfrastructureError) {
    return error;
  }
  const { kind, reason } = classifyPaymentError(error);
  return kind === "policy"
    ? new PolicyError(reason)
    : new InfrastructureError(reason, { cause: error });
}

export interface ExecuteRedemptionParams {
  publicClient: ReadClient;
  walletClient: BoundWalletClient;
  delegationManager: Address;
  token: Address;
  recipient: Address;
  amount: bigint;
  child: Delegation;
  root: Delegation;
  /** Official ERC20TransferAmountEnforcer that tracks the root cumulative spend. */
  budgetEnforcerAddress: Address | null;
  /** Root delegation hash (key of the enforcer's spent map). */
  rootDelegationHash: Hex;
  /** Skip the pre-flight simulation (used by the concurrency test). */
  skipSimulation?: boolean;
  nonce?: number;
  gas?: bigint;
}

export interface ExecutionOutcome {
  txHash: Hex;
  blockNumber: number;
  /** Cumulative root spend after settlement, when the enforcer is known. */
  spentAfter: bigint | null;
}

/**
 * Simulates and submits a child→root redemption. Policy failures (caveat
 * reverts) are surfaced as PolicyError, everything else as InfrastructureError.
 */
export async function executeRedemption(
  params: ExecuteRedemptionParams,
): Promise<ExecutionOutcome> {
  const account = params.walletClient.account;
  if (!account) {
    throw new InfrastructureError("executor wallet client has no account");
  }
  const data = encodeRedeemPayment({
    child: params.child,
    root: params.root,
    token: params.token,
    recipient: params.recipient,
    amount: params.amount,
  });

  if (!params.skipSimulation) {
    try {
      await params.publicClient.call({
        account: account.address,
        to: params.delegationManager,
        data,
      });
    } catch (error) {
      throw toPaymentError(error);
    }
  }

  let txHash: Hex;
  try {
    txHash = await params.walletClient.sendTransaction({
      to: params.delegationManager,
      data,
      ...(params.nonce !== undefined ? { nonce: params.nonce } : {}),
      ...(params.gas !== undefined ? { gas: params.gas } : {}),
    });
  } catch (error) {
    throw toPaymentError(error);
  }

  let blockNumber: number;
  try {
    const receipt = await params.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== "success") {
      // Re-run the call against the post-state to extract the caveat reason.
      let reason: unknown = new Error(`transaction ${txHash} reverted`);
      try {
        await params.publicClient.call({
          account: account.address,
          to: params.delegationManager,
          data,
        });
      } catch (error) {
        reason = error;
      }
      throw toPaymentError(reason);
    }
    blockNumber = Number(receipt.blockNumber);
  } catch (error) {
    throw toPaymentError(error);
  }

  let spentAfter: bigint | null = null;
  if (params.budgetEnforcerAddress) {
    spentAfter = await readDelegationSpent({
      publicClient: params.publicClient,
      enforcerAddress: params.budgetEnforcerAddress,
      delegationManager: params.delegationManager,
      delegationHash: params.rootDelegationHash,
    });
  }

  return { txHash, blockNumber, spentAfter };
}
