import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { decodeDelegations, hashDelegation } from "@metamask/smart-accounts-kit/utils";
import { getAddress, keccak256 } from "viem";
import type { Store } from "@/store";
import type { Purchase } from "@/shared/types";
import { ValidationError } from "@/shared/errors";
import type { ProviderDefinition, ProviderRequestArgs } from "@/providers/types";
import {
  canonicalRequestJson,
  requestHash as computeRequestHash,
} from "@/providers/types";
import type { ProviderExecutionContext } from "@/providers/types";
import type { FacilitatorRequest } from "./facilitator";
import { assertAcceptedMatches, readErc7710Payload } from "./requirements";

export const PAYMENT_ID_HEADER = "x-swarm-payment-id";

export interface ProviderServeContext {
  store: Store;
  provider: ProviderDefinition;
  requirements: PaymentRequirements;
  required: PaymentRequired;
  facilitator: {
    settle(request: FacilitatorRequest): Promise<SettleResponse>;
  };
  dataContext: ProviderExecutionContext;
  network: `${string}:${string}`;
  /** Journal hook so providers can record purchases with the mission context. */
  onPurchase?: (purchase: Purchase) => void;
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function paymentRequiredResponse(
  required: PaymentRequired,
  error: string,
): Response {
  return jsonResponse(
    {
      x402Version: 2,
      error,
      resource: required.resource,
      accepts: required.accepts,
    },
    402,
    { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) },
  );
}

function settledResponseHeader(purchase: Purchase, network: `${string}:${string}`): string {
  const response: SettleResponse = {
    success: true,
    transaction: purchase.txHash ?? "",
    network,
    amount: purchase.amount.toString(),
    ...(purchase.payer ? { payer: purchase.payer } : {}),
    extensions: {
      swarm: {
        blockNumber: purchase.blockNumber,
        spentAfter: purchase.spentAfter === null ? null : purchase.spentAfter.toString(),
        paymentId: purchase.paymentId,
      },
    },
  };
  return encodePaymentResponseHeader(response);
}

function failureResponse(
  settlement: SettleResponse,
  message: string,
): Response {
  return jsonResponse(
    {
      x402Version: 2,
      error: settlement.errorReason ?? "settlement_failed",
      message,
      network: settlement.network,
    },
    402,
    { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) },
  );
}

async function serveResult(
  purchase: Purchase,
  args: ProviderRequestArgs,
  context: ProviderServeContext,
): Promise<Response> {
  try {
    const result = await context.provider.run(args, context.dataContext);
    const factsJson = JSON.stringify(result.facts);
    const responseHash = keccak256(new TextEncoder().encode(factsJson));
    context.store.completePurchaseResult(purchase.id, {
      responseHash,
      resultJson: factsJson,
    });
    const body = {
      providerId: context.provider.id,
      request: JSON.parse(purchase.requestJson) as ProviderRequestArgs,
      facts: result.facts,
      blockNumber: result.blockNumber,
      source: {
        txHash: purchase.txHash,
        blockNumber: purchase.blockNumber,
        payer: purchase.payer,
        responseHash,
      },
    };
    context.onPurchase?.(context.store.getPurchase(purchase.id));
    return jsonResponse(body, 200, {
      "PAYMENT-RESPONSE": settledResponseHeader(
        context.store.getPurchase(purchase.id),
        context.network,
      ),
      [PAYMENT_ID_HEADER]: purchase.paymentId,
      "x-swarm-idempotent": "false",
    });
  } catch (error) {
    // The payment is already settled; keep the receipt and let a retry with
    // the same paymentId serve the data without charging again.
    context.onPurchase?.(context.store.getPurchase(purchase.id));
    return jsonResponse(
      {
        x402Version: 2,
        error: "data_source_error",
        message: error instanceof Error ? error.message : String(error),
        paymentId: purchase.paymentId,
      },
      502,
      {
        "PAYMENT-RESPONSE": settledResponseHeader(purchase, context.network),
      },
    );
  }
}

/**
 * Provider-side x402 endpoint logic:
 *
 *   402 + PAYMENT-REQUIRED
 *     -> PAYMENT-SIGNATURE payload
 *     -> terms validation + idempotency
 *     -> facilitator settle (verify + confirmed ERC-7710 redemption)
 *     -> paid data, only after the settlement receipt
 *
 * `extra.paymentFlow` is `upfront`, so the data is never served on the strength
 * of verification alone, and concurrent requests that pass verification but do
 * not fit into the shared budget fail at settlement with no data returned.
 */
export async function servePaidProvider(
  request: Request,
  args: ProviderRequestArgs,
  context: ProviderServeContext,
): Promise<Response> {
  const paymentSignature =
    request.headers.get("PAYMENT-SIGNATURE") ??
    request.headers.get("X-PAYMENT");
  const paymentId = request.headers.get(PAYMENT_ID_HEADER);

  if (!paymentSignature) {
    return paymentRequiredResponse(
      context.required,
      "PAYMENT-SIGNATURE header is required",
    );
  }
  if (!paymentId) {
    return jsonResponse(
      {
        x402Version: 2,
        error: "invalid_payload",
        message: `${PAYMENT_ID_HEADER} header is required for idempotency`,
      },
      400,
    );
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(paymentSignature);
  } catch {
    return jsonResponse(
      { x402Version: 2, error: "invalid_payload", message: "malformed payment header" },
      400,
    );
  }

  try {
    assertAcceptedMatches(paymentPayload.accepted, context.requirements);
    readErc7710Payload(paymentPayload);
  } catch (error) {
    return jsonResponse(
      {
        x402Version: 2,
        error: error instanceof ValidationError ? error.message : "invalid_payload",
      },
      400,
    );
  }

  const requestJson = canonicalRequestJson(context.provider.id, args);
  const requestHash = computeRequestHash(context.provider.id, args);

  // Bind the payment to a mission registered in this app: the root delegation
  // in the permission context must be the stored mission root.
  let missionId: string | null = null;
  try {
    const payload = readErc7710Payload(paymentPayload);
    const delegations = decodeDelegations(payload.permissionContext);
    const root = delegations[delegations.length - 1];
    if (root) {
      const rootHash = hashDelegation(root);
      missionId = context.store.findMissionByRootHash(rootHash)?.id ?? null;
    }
  } catch {
    missionId = null;
  }
  if (!missionId) {
    return jsonResponse(
      {
        x402Version: 2,
        error: "unknown_mission",
        message:
          "the permission context root does not match any registered SWARM TAB mission",
      },
      402,
      { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(context.required) },
    );
  }

  const existing = context.store.getPurchaseByPaymentId(
    context.provider.id,
    paymentId,
  );
  if (existing) {
    if (existing.missionId !== missionId || existing.requestHash !== requestHash) {
      return jsonResponse(
        {
          x402Version: 2,
          error: "payment_id_conflict",
          message: `paymentId ${paymentId} was already used for a different mission or request`,
        },
        409,
      );
    }
    if (existing.state === "pending") {
      return jsonResponse(
        {
          x402Version: 2,
          error: "payment_in_progress",
          message: `paymentId ${paymentId} is being processed`,
        },
        409,
      );
    }
    if (existing.state === "settled") {
      if (existing.resultJson !== null) {
        const facts = JSON.parse(existing.resultJson) as Record<string, unknown>;
        return jsonResponse(
          {
            providerId: context.provider.id,
            request: JSON.parse(existing.requestJson) as ProviderRequestArgs,
            facts,
            // Receipt block and observed data block can differ.
            blockNumber: facts.blockNumber,
            source: {
              txHash: existing.txHash,
              blockNumber: existing.blockNumber,
              payer: existing.payer,
              responseHash: existing.responseHash,
            },
          },
          200,
          {
            "PAYMENT-RESPONSE": settledResponseHeader(existing, context.network),
            [PAYMENT_ID_HEADER]: existing.paymentId,
            "x-swarm-idempotent": "true",
          },
        );
      }
      // Settled but the data read failed earlier: serve now, no new charge.
      return serveResult(existing, args, context);
    }
    // A refusal is returned as-is; a repeat never charges again.
    return jsonResponse(
      {
        x402Version: 2,
        error: existing.errorKind === "policy" ? "payment_rejected" : "payment_failed",
        message: existing.reason,
        paymentId,
      },
      402,
      {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader({
          success: false,
          errorReason: existing.reason ?? "payment_failed",
          transaction: (existing.txHash ?? "") as `0x${string}`,
          network: context.network,
          ...(existing.payer ? { payer: existing.payer } : {}),
        }),
      },
    );
  }

  let purchase: Purchase;
  try {
    purchase = context.store.createPurchase({
      missionId,
      paymentId,
      providerId: context.provider.id,
      requestHash,
      amount: context.provider.price,
      payTo: getAddress(context.requirements.payTo),
      requestJson,
    });
  } catch (error) {
    return jsonResponse(
      {
        x402Version: 2,
        error: "payment_in_progress",
        message: error instanceof Error ? error.message : String(error),
      },
      409,
    );
  }

  const settlement = await context.facilitator.settle({
    x402Version: 2,
    paymentPayload,
    paymentRequirements: context.requirements,
    paymentId,
  });

  if (!settlement.success) {
    const kind =
      settlement.errorReason === "insufficient_funds" ||
      settlement.errorReason === "swarm_policy_rejected" ||
      settlement.errorReason?.startsWith("invalid_")
        ? "policy"
        : "infrastructure";
    const failed = context.store.transitionPurchase(purchase.id, kind === "policy" ? "rejected" : "failed", {
      errorKind: kind,
      reason: settlement.errorReason ?? "settlement_failed",
      txHash: (settlement.transaction || null) as `0x${string}` | null,
      payer: settlement.payer ? (settlement.payer as Purchase["payer"]) : null,
    });
    context.onPurchase?.(failed);
    return failureResponse(
      settlement,
      `settlement failed: ${settlement.errorReason ?? "unknown"}`,
    );
  }

  const swarmMeta = (
    settlement.extensions as
      | { swarm?: { blockNumber?: number; spentAfter?: string | null } }
      | undefined
  )?.swarm;
  const settled = context.store.transitionPurchase(purchase.id, "settled", {
    txHash: settlement.transaction as `0x${string}`,
    blockNumber: swarmMeta?.blockNumber ?? null,
    spentAfter:
      swarmMeta?.spentAfter !== undefined && swarmMeta.spentAfter !== null
        ? BigInt(swarmMeta.spentAfter)
        : null,
    payer: settlement.payer ? (settlement.payer as Purchase["payer"]) : null,
  });
  context.onPurchase?.(settled);
  return serveResult(settled, args, context);
}
