import { ExecutionMode, createExecution } from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import {
  decodeDelegations,
  hashDelegation,
} from "@metamask/smart-accounts-kit/utils";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress, type Address, type Hex } from "viem";
import { errorMessage } from "@/shared/errors";
import type { BoundWalletClient, ReadClient } from "@/payments/clients";
import { toPaymentError } from "@/payments/executor";
import { transferCalldata } from "@/payments/permissions";
import { readDelegationSpent } from "@/payments/spend";
import {
  assertAcceptedMatches,
  readErc7710Payload,
  toCaip2,
} from "./requirements";

/**
 * Serializes relayer transactions and hands out consecutive nonces, so several
 * concurrent x402 settles cannot collide on the relayer nonce.
 */
export class RelayerQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private nextNonceValue: number | null = null;

  constructor(
    private readonly publicClient: ReadClient,
    private readonly address: Address,
  ) {}

  private async takeNonce(): Promise<number> {
    if (this.nextNonceValue === null) {
      this.nextNonceValue = await this.publicClient.getTransactionCount({
        address: this.address,
        blockTag: "pending",
      });
    }
    return this.nextNonceValue++;
  }

  run<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const nonce = await this.takeNonce();
      try {
        return await fn(nonce);
      } catch (error) {
        // Re-read the pending nonce after any failure.
        this.nextNonceValue = null;
        throw error;
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export interface FacilitatorContext {
  publicClient: ReadClient;
  walletClient: BoundWalletClient;
  relayerAddress: Address;
  delegationManager: Address;
  chainId: number;
  budgetEnforcerAddress: Address | null;
  queue: RelayerQueue;
  /** Optional hook so the app can journal facilitator activity. */
  onSettled?: (meta: {
    txHash: Hex;
    blockNumber: number;
    paymentId: string | null;
  }) => void;
}

export interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  /** SWARM TAB extension: lets providers correlate the settle with their journal. */
  paymentId?: string | null;
}

interface RedemptionCall {
  data: Hex;
  rootDelegationHash: Hex | null;
}

function buildRedemption(
  request: FacilitatorRequest,
  context: FacilitatorContext,
): RedemptionCall {
  if (request.x402Version !== 2 || request.paymentPayload.x402Version !== 2) {
    throw new Error("invalid_x402_version");
  }
  if (request.paymentRequirements.scheme !== "exact") throw new Error("invalid_scheme");
  if (request.paymentRequirements.network !== toCaip2(context.chainId)) {
    throw new Error("invalid_network");
  }
  assertAcceptedMatches(
    request.paymentPayload.accepted,
    request.paymentRequirements,
  );
  const payload = readErc7710Payload(request.paymentPayload);
  if (
    getAddress(payload.delegationManager) !== getAddress(context.delegationManager)
  ) {
    throw new Error("invalid_delegation_manager");
  }
  const delegations = decodeDelegations(payload.permissionContext);
  if (delegations.length === 0) {
    throw new Error("invalid_payload");
  }
  const root = delegations[delegations.length - 1];
  if (getAddress(payload.delegator) !== getAddress(root.delegator)) {
    throw new Error("invalid_payload");
  }
  const execution = createExecution({
    target: getAddress(request.paymentRequirements.asset),
    callData: transferCalldata(
      getAddress(request.paymentRequirements.payTo),
      BigInt(request.paymentRequirements.amount),
    ),
  });
  const data = DelegationManager.encode.redeemDelegations({
    delegations: [delegations],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  });
  const rootDelegationHash =
    root && root.authority === `0x${"ff".repeat(32)}`
      ? hashDelegation(root)
      : null;
  return { data, rootDelegationHash };
}

function mapInvalidReason(error: unknown): string {
  const validationReason = errorMessage(error);
  if (/^invalid_[a-z0-9_]+$/.test(validationReason)) return validationReason;
  const paymentError = toPaymentError(error);
  const reason = errorMessage(paymentError);
  if (/allowance-exceeded/i.test(reason)) return "insufficient_funds";
  if (/CannotUseADisabledDelegation/i.test(reason)) {
    return "invalid_transaction_state";
  }
  if (/TimestampEnforcer|expired/i.test(reason)) {
    return "invalid_exact_evm_payload_authorization_valid_before";
  }
  if (/MissionPolicyEnforcerRecipientNotAllowed/i.test(reason)) {
    return "invalid_exact_evm_payload_recipient_mismatch";
  }
  if (/LimitedCallsEnforcer/i.test(reason)) return "invalid_transaction_state";
  if (paymentError.kind === "policy") return "swarm_policy_rejected";
  return "unexpected_verify_error";
}

/**
 * Read-only verification: checks the payload shape and the advertised terms,
 * then simulates `redeemDelegations` with the relayer as the caller. The
 * simulation is the real caveat/budget check — no state is written.
 */
export async function verifyPayment(
  request: FacilitatorRequest,
  context: FacilitatorContext,
): Promise<VerifyResponse> {
  try {
    assertAcceptedMatches(
      request.paymentPayload.accepted,
      request.paymentRequirements,
    );
    const payload = readErc7710Payload(request.paymentPayload);
    if (
      getAddress(payload.delegationManager) !==
      getAddress(context.delegationManager)
    ) {
      return { isValid: false, invalidReason: "invalid_payload" };
    }
    const redemption = buildRedemption(request, context);
    await context.publicClient.call({
      account: context.relayerAddress,
      to: context.delegationManager,
      data: redemption.data,
    });
    return { isValid: true, payer: payload.delegator };
  } catch (error) {
    return { isValid: false, invalidReason: mapInvalidReason(error) };
  }
}

/**
 * Verifies and then settles by broadcasting `redeemDelegations` from the
 * relayer and waiting for a receipt. Only a mined, successful transaction is
 * reported as `success: true`.
 */
export async function settlePayment(
  request: FacilitatorRequest,
  context: FacilitatorContext,
): Promise<SettleResponse> {
  const network = toCaip2(context.chainId);
  const verified = await verifyPayment(request, context);
  if (!verified.isValid) {
    return {
      success: false,
      errorReason: verified.invalidReason ?? "invalid_payload",
      transaction: "",
      network,
      ...(verified.payer ? { payer: verified.payer } : {}),
    };
  }

  const redemption = buildRedemption(request, context);
  let txHash: Hex;
  try {
    txHash = await context.queue.run((nonce) =>
      context.walletClient.sendTransaction({
        to: context.delegationManager,
        data: redemption.data,
        nonce,
        gas: 2_500_000n,
      }),
    );
  } catch (error) {
    return {
      success: false,
      errorReason: mapInvalidReason(error),
      transaction: "",
      network,
      ...(verified.payer ? { payer: verified.payer } : {}),
    };
  }

  let receipt: { status: string; blockNumber: bigint } | null = null;
  try {
    const mined = await context.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });
    receipt = { status: mined.status, blockNumber: mined.blockNumber };
  } catch {
    receipt = null;
  }

  if (!receipt) {
    return {
      success: false,
      errorReason: "settlement_pending",
      transaction: txHash,
      network,
      ...(verified.payer ? { payer: verified.payer } : {}),
    };
  }

  if (receipt.status !== "success") {
    // Re-simulate against the post-state for a precise reason.
    let reason: unknown = new Error("transaction reverted");
    try {
      await context.publicClient.call({
        account: context.relayerAddress,
        to: context.delegationManager,
        data: redemption.data,
      });
    } catch (error) {
      reason = error;
    }
    return {
      success: false,
      errorReason: mapInvalidReason(reason),
      transaction: "",
      network,
      ...(verified.payer ? { payer: verified.payer } : {}),
    };
  }

  let spentAfter: bigint | null = null;
  if (context.budgetEnforcerAddress && redemption.rootDelegationHash) {
    try {
      spentAfter = await readDelegationSpent({
        publicClient: context.publicClient,
        enforcerAddress: context.budgetEnforcerAddress,
        delegationManager: context.delegationManager,
        delegationHash: redemption.rootDelegationHash,
      });
    } catch {
      spentAfter = null;
    }
  }

  const blockNumber = Number(receipt.blockNumber);
  context.onSettled?.({
    txHash,
    blockNumber,
    paymentId: request.paymentId ?? null,
  });
  return {
    success: true,
    transaction: txHash,
    network,
    amount: request.paymentRequirements.amount,
    ...(verified.payer ? { payer: verified.payer } : {}),
    extensions: {
      swarm: {
        blockNumber,
        spentAfter: spentAfter === null ? null : spentAfter.toString(),
      },
    },
  };
}
