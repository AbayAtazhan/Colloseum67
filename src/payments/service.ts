import { getAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { Delegation, SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import type { Store } from "@/store";
import { errorKindOf, errorMessage } from "@/shared/errors";
import type { PaymentAttempt, PaymentRequest } from "@/shared/types";
import type { BoundWalletClient, ReadClient } from "./clients";
import { assertPaymentAllowed } from "./policy";
import {
  buildOneShotChildDelegation,
  delegationHash,
  encodeRedeemPayment,
  signDelegationWithAccount,
} from "./permissions";
import { executeRedemption } from "./executor";

export interface PaymentContext {
  store: Store;
  publicClient: ReadClient;
  walletClient: BoundWalletClient;
  executor: LocalAccount;
  environment: SmartAccountsEnvironment;
  delegationManager: Address;
  chainId: number;
  /** Custom recipient/per-call policy enforcer used in caveats. */
  enforcerAddress: Address | null;
  /** Official ERC20TransferAmountEnforcer that tracks the root mission spend. */
  budgetEnforcerAddress: Address;
  validForSeconds?: number;
}

export interface PreparedPayment {
  attempt: PaymentAttempt;
  child: Delegation;
  redeemCalldata: Hex;
}

export interface SubmitOptions {
  /** Run the read-only simulation before sending (default true). */
  simulate?: boolean;
  nonce?: number;
  gas?: bigint;
}

/**
 * Orchestrates the payment lifecycle:
 *
 *   requested -> (server policy) -> authorized (one-shot child signed)
 *   -> submitted -> settled
 *
 * Policy refusals become `rejected`; infrastructure problems become `failed`.
 * The one-shot child delegation is created by the executor and is always
 * attenuated against the mission root, which only the user could sign.
 */
export class PaymentService {
  constructor(private readonly ctx: PaymentContext) {}

  async prepare(request: PaymentRequest): Promise<PreparedPayment> {
    const mission = this.ctx.store.getMission(request.missionId);
    const recipient = getAddress(request.recipient);
    const spent = this.ctx.store.computeMissionSpent(mission.id);
    const attempt = this.ctx.store.createPaymentAttempt({
      missionId: mission.id,
      agentRunId: request.agentRunId ?? null,
      recipient,
      amount: request.amount,
    });

    try {
      assertPaymentAllowed({
        policy: mission.policy,
        missionStatus: mission.status,
        recipient,
        amount: request.amount,
        spent,
      });
    } catch (error) {
      this.reject(attempt.id, error);
      throw error;
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const validUntil = Math.min(
        mission.policy.validBefore,
        now + (this.ctx.validForSeconds ?? 600),
      );
      const unsigned = buildOneShotChildDelegation({
        environment: this.ctx.environment,
        from: this.ctx.executor.address,
        to: this.ctx.executor.address,
        parentDelegation: mission.rootDelegation,
        policy: mission.policy,
        enforcerAddress: this.ctx.enforcerAddress,
        recipient,
        amount: request.amount,
        validUntil,
      });
      const child = await signDelegationWithAccount(
        this.ctx.executor,
        unsigned,
        this.ctx.chainId,
        this.ctx.delegationManager,
      );
      const updated = this.ctx.store.transitionPaymentAttempt(attempt.id, "authorized", {
        childDelegation: child,
        delegationHash: delegationHash(child),
      });
      const redeemCalldata = encodeRedeemPayment({
        child,
        root: mission.rootDelegation,
        token: mission.policy.token.address,
        recipient,
        amount: request.amount,
      });
      return { attempt: updated, child, redeemCalldata };
    } catch (error) {
      this.fail(attempt.id, error);
      throw error;
    }
  }

  async submit(
    prepared: PreparedPayment,
    options: SubmitOptions = {},
  ): Promise<PaymentAttempt> {
    const mission = this.ctx.store.getMission(prepared.attempt.missionId);
    this.ctx.store.transitionPaymentAttempt(prepared.attempt.id, "submitted");

    try {
      const outcome = await executeRedemption({
        publicClient: this.ctx.publicClient,
        walletClient: this.ctx.walletClient,
        delegationManager: this.ctx.delegationManager,
        token: mission.policy.token.address,
        recipient: prepared.attempt.recipient,
        amount: prepared.attempt.amount,
        child: prepared.child,
        root: mission.rootDelegation,
        budgetEnforcerAddress: this.ctx.budgetEnforcerAddress,
        rootDelegationHash: mission.rootDelegationHash,
        skipSimulation: options.simulate === false,
        nonce: options.nonce,
        gas: options.gas,
      });

      this.ctx.store.transitionPaymentAttempt(prepared.attempt.id, "settled", {
        txHash: outcome.txHash,
      });
      const spentBefore = this.ctx.store.computeMissionSpent(mission.id);
      this.ctx.store.insertReceipt({
        attemptId: prepared.attempt.id,
        missionId: mission.id,
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
        recipient: prepared.attempt.recipient,
        amount: prepared.attempt.amount,
        spentAfter: outcome.spentAfter ?? spentBefore + prepared.attempt.amount,
      });
      return this.ctx.store.getPaymentAttempt(prepared.attempt.id);
    } catch (error) {
      const kind = errorKindOf(error);
      const next = kind === "policy" ? "rejected" : "failed";
      this.ctx.store.transitionPaymentAttempt(prepared.attempt.id, next, {
        errorKind: kind,
        reason: errorMessage(error),
      });
      throw error;
    }
  }

  async execute(
    request: PaymentRequest,
    options: SubmitOptions = {},
  ): Promise<PaymentAttempt> {
    const prepared = await this.prepare(request);
    return this.submit(prepared, options);
  }

  private reject(attemptId: string, error: unknown): void {
    this.ctx.store.transitionPaymentAttempt(attemptId, "rejected", {
      errorKind: "policy",
      reason: errorMessage(error),
    });
  }

  private fail(attemptId: string, error: unknown): void {
    const kind = errorKindOf(error);
    this.ctx.store.transitionPaymentAttempt(
      attemptId,
      kind === "policy" ? "rejected" : "failed",
      { errorKind: kind, reason: errorMessage(error) },
    );
  }
}
