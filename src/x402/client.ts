import {
  createx402DelegationProvider,
  parseEip155ChainId,
} from "@metamask/smart-accounts-kit/experimental";
import type {
  SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {
  decodeDelegations,
  generateSalt,
  hashDelegation,
} from "@metamask/smart-accounts-kit/utils";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { getAddress, keccak256, type Address } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { Store } from "@/store";
import { InfrastructureError, PolicyError, ValidationError } from "@/shared/errors";
import type { MissionRecord, ProviderId, TokenInfo } from "@/shared/types";
import type { ReadClient } from "@/payments/clients";
import { readDelegationSpent } from "@/payments/spend";
import { TRANSFER_SELECTOR } from "@/payments/permissions";
import type { ProviderDefinition, ProviderRequestArgs } from "@/providers/types";
import { canonicalRequestJson } from "@/providers/types";

export interface X402AgentClientContext {
  store: Store;
  mission: MissionRecord;
  publicClient: ReadClient;
  executor: LocalAccount;
  environment: SmartAccountsEnvironment;
  chainId: number;
  relayerAddress: Address;
  token: TokenInfo;
  budgetEnforcerAddress: Address;
  providers: Record<ProviderId, ProviderDefinition>;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface PaidRequestSuccess {
  ok: true;
  paymentId: string;
  providerId: ProviderId;
  request: Record<string, unknown>;
  facts: Record<string, unknown>;
  blockNumber: number | null;
  txHash: `0x${string}`;
  responseHash: `0x${string}`;
  spentAfter: bigint;
  idempotent: boolean;
}

export interface PaidRequestFailure {
  ok: false;
  paymentId: string;
  providerId: ProviderId;
  request: Record<string, unknown>;
  state: "rejected" | "failed";
  reason: string;
}

export type PaidRequestResult = PaidRequestSuccess | PaidRequestFailure;

const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

function failureReasonFrom(response: Response, body: unknown): string {
  const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
  if (paymentResponse) {
    try {
      const decoded = decodePaymentResponseHeader(paymentResponse);
      const code = decoded.errorReason ?? "settlement_failed";
      const message =
        body && typeof body === "object" && "message" in body
          ? String((body as { message?: unknown }).message)
          : "";
      return message ? `${code}: ${message}` : code;
    } catch {
      // fall through to the body
    }
  }
  if (body && typeof body === "object") {
    const record = body as { error?: unknown; message?: unknown };
    const error = record.error ? String(record.error) : "payment_failed";
    const message = record.message ? String(record.message) : "";
    return message ? `${error}: ${message}` : error;
  }
  return `payment_failed_http_${response.status}`;
}

function policyFailure(reason: string): boolean {
  return (
    reason.includes("insufficient_funds") ||
    reason.includes("swarm_policy_rejected") ||
    reason.includes("payment_rejected") ||
    reason.startsWith("invalid_") ||
    /allowance-exceeded/i.test(reason) ||
    /budget/i.test(reason)
  );
}

/**
 * Agent-side x402 client for ERC-7710 exact payments.
 *
 * The child delegation is produced by the official MetaMask
 * `createx402DelegationProvider` helper, but always with the mission root as
 * `parentPermissionContext`, and we explicitly verify that the resulting chain
 * still ends in the stored mission root hash. The helper therefore cannot
 * create a new independent root budget per request.
 */
export class X402AgentClient {
  constructor(private readonly ctx: X402AgentClientContext) {}

  async requestPaidData(
    providerId: ProviderId,
    args: ProviderRequestArgs,
    options: { agentRunId?: string | null } = {},
  ): Promise<PaidRequestResult> {
    const provider = this.ctx.providers[providerId];
    if (!provider) {
      throw new ValidationError(`unknown provider: ${providerId}`);
    }
    const fetchImpl = this.ctx.fetchImpl ?? fetch;
    const requestJson = canonicalRequestJson(providerId, args);
    const paymentId = `swarm-${crypto.randomUUID()}`;
    const url = new URL(
      `${this.ctx.baseUrl.replace(/\/$/, "")}${provider.path}`,
    );
    url.searchParams.set("address", getAddress(args.address));
    if (args.blockNumber !== undefined) {
      url.searchParams.set("blockNumber", String(args.blockNumber));
    }
    if (args.compareAddress) url.searchParams.set("compareAddress", getAddress(args.compareAddress));
    if (args.positionUsd !== undefined) url.searchParams.set("positionUsd", args.positionUsd);
    if (args.depth !== undefined) url.searchParams.set("depth", String(args.depth));

    const attempt = this.ctx.store.createPaymentAttempt({
      missionId: this.ctx.mission.id,
      agentRunId: options.agentRunId ?? null,
      recipient: provider.payTo,
      amount: provider.price,
    });

    type AttemptPatch = Parameters<typeof this.ctx.store.transitionPaymentAttempt>[2];

    try {
      // Phase 1: obtain the payment requirements.
      const challenge = await fetchImpl(url, { method: "GET" });
      if (challenge.ok) {
        throw new InfrastructureError(
          "provider returned data without a payment challenge",
        );
      }
      if (challenge.status !== 402) {
        throw new InfrastructureError(
          `provider responded ${challenge.status} instead of 402`,
        );
      }
      const requirements = await this.readRequirements(challenge);
      this.assertRequirements(provider, requirements);

      // Phase 2: build a one-shot child under the shared mission root.
      const payload = await this.buildPaymentPayload(requirements);
      const delegations = decodeDelegations(payload.permissionContext);
      const root = delegations[delegations.length - 1];
      if (!root) {
        throw new PolicyError("x402 payment payload has an empty permission chain");
      }
      const rootHash = hashDelegation(root);
      if (rootHash !== this.ctx.mission.rootDelegationHash) {
        throw new PolicyError(
          "x402 helper created a different root budget; refusing to pay",
        );
      }
      if (delegations.length !== 2) {
        throw new PolicyError(
          `expected a child→root permission chain, got ${delegations.length} links`,
        );
      }
      const child = delegations[0];
      this.ctx.store.transitionPaymentAttempt(attempt.id, "authorized", {
        childDelegation: child,
        delegationHash: hashDelegation(child),
      });

      // Phase 3: retry the request with the payment payload. Retrying with the
      // same paymentId is safe: the provider returns the cached settlement
      // instead of charging again.
      const paymentPayload: PaymentPayload = {
        x402Version: 2,
        accepted: requirements,
        payload: payload as unknown as Record<string, unknown>,
      };
      const signatureHeader = encodePaymentSignatureHeader(paymentPayload);

      let response: Response | null = null;
      let lastError: unknown = null;
      for (let attemptNumber = 0; attemptNumber <= 2; attemptNumber += 1) {
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: {
              "PAYMENT-SIGNATURE": signatureHeader,
              "X-SWARM-PAYMENT-ID": paymentId,
            },
          });
          if (TRANSIENT_STATUS.has(response.status) && attemptNumber < 2) {
            await new Promise((resolve) => setTimeout(resolve, 300 * (attemptNumber + 1)));
            continue;
          }
          break;
        } catch (error) {
          lastError = error;
          if (attemptNumber < 2) {
            await new Promise((resolve) => setTimeout(resolve, 300 * (attemptNumber + 1)));
            continue;
          }
          throw new InfrastructureError(
            `provider request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!response) {
        throw new InfrastructureError(
          `provider request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      }

      const body = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;

      this.ctx.store.transitionPaymentAttempt(attempt.id, "submitted");

      if (response.status !== 200) {
        const reason = failureReasonFrom(response, body);
        const kind = policyFailure(reason) ? "policy" : "infrastructure";
        this.ctx.store.transitionPaymentAttempt(
          attempt.id,
          kind === "policy" ? "rejected" : "failed",
          { errorKind: kind, reason, txHash: this.responseTxHash(response) },
        );
        return {
          ok: false,
          paymentId,
          providerId,
          request: JSON.parse(requestJson) as Record<string, unknown>,
          state: kind === "policy" ? "rejected" : "failed",
          reason,
        };
      }

      const settlementHeader = response.headers.get("PAYMENT-RESPONSE");
      const settlement = settlementHeader
        ? decodePaymentResponseHeader(settlementHeader)
        : null;
      if (settlement && !settlement.success) {
        const reason = settlement.errorReason ?? "settlement_failed";
        this.ctx.store.transitionPaymentAttempt(attempt.id, "rejected", {
          errorKind: "policy",
          reason,
        });
        return {
          ok: false,
          paymentId,
          providerId,
          request: JSON.parse(requestJson) as Record<string, unknown>,
          state: "rejected",
          reason,
        };
      }
      if (!settlement?.transaction) {
        throw new InfrastructureError(
          "provider did not return a settlement transaction",
        );
      }

      const facts = (body?.facts ?? {}) as Record<string, unknown>;
      const source = (body?.source ?? {}) as Record<string, unknown>;
      const expectedHash = keccak256(
        new TextEncoder().encode(JSON.stringify(facts)),
      );
      if (source.responseHash && source.responseHash !== expectedHash) {
        throw new InfrastructureError("provider response hash mismatch");
      }

      const spentPrevious = this.ctx.store.computeMissionSpent(this.ctx.mission.id);
      const spentAfter =
        (await readDelegationSpent({
          publicClient: this.ctx.publicClient,
          enforcerAddress: this.ctx.budgetEnforcerAddress,
          delegationManager: this.ctx.environment.DelegationManager,
          delegationHash: this.ctx.mission.rootDelegationHash,
        }).catch(() => null)) ?? spentPrevious;

      this.ctx.store.transitionPaymentAttempt(attempt.id, "settled", {
        txHash: settlement.transaction as `0x${string}`,
      });
      this.ctx.store.insertReceipt({
        attemptId: attempt.id,
        missionId: this.ctx.mission.id,
        txHash: settlement.transaction as `0x${string}`,
        blockNumber:
          Number(
            (settlement.extensions as { swarm?: { blockNumber?: number } } | undefined)
              ?.swarm?.blockNumber ?? body?.blockNumber ?? 0,
          ) || 0,
        recipient: provider.payTo,
        amount: provider.price,
        spentAfter,
      });

      return {
        ok: true,
        paymentId,
        providerId,
        request: JSON.parse(requestJson) as Record<string, unknown>,
        facts,
        blockNumber: typeof body?.blockNumber === "number" ? body.blockNumber : null,
        txHash: settlement.transaction as `0x${string}`,
        responseHash: (source.responseHash as `0x${string}` | undefined) ?? expectedHash,
        spentAfter,
        idempotent: response.headers.get("x-swarm-idempotent") === "true",
      };
    } catch (error) {
      const kind =
        error instanceof PolicyError
          ? "policy"
          : error instanceof ValidationError
            ? "policy"
            : "infrastructure";
      const reason = error instanceof Error ? error.message : String(error);
      const current = this.ctx.store.getPaymentAttempt(attempt.id);
      if (current.state === "requested" || current.state === "authorized" || current.state === "submitted") {
        this.ctx.store.transitionPaymentAttempt(
          attempt.id,
          kind === "policy" ? "rejected" : "failed",
          { errorKind: kind, reason } as AttemptPatch,
        );
      }
      return {
        ok: false,
        paymentId,
        providerId,
        request: JSON.parse(requestJson) as Record<string, unknown>,
        state: kind === "policy" ? "rejected" : "failed",
        reason,
      };
    }
  }

  private responseTxHash(response: Response): `0x${string}` | null {
    const header = response.headers.get("PAYMENT-RESPONSE");
    if (!header) return null;
    try {
      const decoded = decodePaymentResponseHeader(header);
      return decoded.transaction ? (decoded.transaction as `0x${string}`) : null;
    } catch {
      return null;
    }
  }

  private async readRequirements(response: Response): Promise<PaymentRequirements> {
    const header = response.headers.get("PAYMENT-REQUIRED");
    if (header) {
      const required = decodePaymentRequiredHeader(header);
      const first = required.accepts?.[0];
      if (first) return first;
    }
    const body = (await response.json().catch(() => null)) as {
      accepts?: PaymentRequirements[];
    } | null;
    const first = body?.accepts?.[0];
    if (!first) {
      throw new InfrastructureError("provider did not advertise payment terms");
    }
    return first;
  }

  private assertRequirements(
    provider: ProviderDefinition,
    requirements: PaymentRequirements,
  ): void {
    const { ctx } = this;
    if (requirements.scheme !== "exact") {
      throw new PolicyError(`unsupported scheme: ${requirements.scheme}`);
    }
    if (parseEip155ChainId(requirements.network) !== ctx.chainId) {
      throw new PolicyError(`wrong network in payment terms: ${requirements.network}`);
    }
    if (getAddress(requirements.asset) !== getAddress(ctx.token.address)) {
      throw new PolicyError("payment asset is not the mission token");
    }
    if (getAddress(requirements.payTo) !== getAddress(provider.payTo)) {
      throw new PolicyError("payment payee does not match the provider registry");
    }
    if (BigInt(requirements.amount) !== provider.price) {
      throw new PolicyError("payment amount does not match the provider registry");
    }
    if (requirements.extra?.assetTransferMethod !== "erc7710") {
      throw new PolicyError("provider does not accept ERC-7710 payments");
    }
    const facilitators = requirements.extra?.facilitatorAddresses;
    if (
      !Array.isArray(facilitators) ||
      !facilitators.some(
        (address: unknown) =>
          typeof address === "string" &&
          getAddress(address) === getAddress(ctx.relayerAddress),
      )
    ) {
      throw new PolicyError("provider does not name the configured relayer");
    }
  }

  private async buildPaymentPayload(
    requirements: PaymentRequirements,
  ): Promise<{ delegationManager: `0x${string}`; permissionContext: `0x${string}`; delegator: `0x${string}` }> {
    const providerHelper = createx402DelegationProvider({
      account: this.ctx.executor,
      environment: this.ctx.environment,
      from: this.ctx.executor.address,
      parentPermissionContext: [this.ctx.mission.rootDelegation],
      salt: generateSalt(),
      expirySeconds: 300,
      caveats: [
        { type: "limitedCalls", limit: 1 },
        { type: "allowedTargets", targets: [this.ctx.token.address] },
        { type: "allowedMethods", selectors: [TRANSFER_SELECTOR] },
      ],
      redeemers: { requireRedeemers: true, addresses: [this.ctx.relayerAddress] },
    });
    return providerHelper(requirements);
  }
}
