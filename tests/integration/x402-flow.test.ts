import { beforeAll, describe, expect, it } from "vitest";
import { createx402DelegationProvider } from "@metamask/smart-accounts-kit/experimental";
import { generateSalt } from "@metamask/smart-accounts-kit/utils";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { Store } from "@/store";
import { parseAmount } from "@/shared/amounts";
import { X402AgentClient } from "@/x402/client";
import { buildPaymentRequirements } from "@/x402/requirements";
import { readDelegationSpent, readTokenBalance } from "@/payments/spend";
import { verifyPayment } from "@/x402/facilitator";
import {
  createTestContext,
  createTestMission,
  type TestContext,
} from "../harness/context";
import { createX402Harness, type X402Harness } from "../harness/x402";

const usdc = (value: string) => parseAmount(value, 6);

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

function agentClient(
  store: Store,
  mission: Awaited<ReturnType<typeof createTestMission>>,
  harness: X402Harness,
): X402AgentClient {
  return new X402AgentClient({
    store,
    mission,
    publicClient: ctx.publicClient,
    executor: ctx.accounts.executor,
    environment: ctx.meta.environment,
    chainId: ctx.meta.chainId,
    relayerAddress: ctx.meta.relayerAddress,
    token: { address: ctx.meta.tokenAddress, symbol: "USDC", decimals: 6 },
    budgetEnforcerAddress:
      ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    providers: harness.providers,
    baseUrl: harness.baseUrl,
    fetchImpl: harness.fetchImpl,
  });
}

async function rootSpent(mission: { rootDelegationHash: `0x${string}` }) {
  return readDelegationSpent({
    publicClient: ctx.publicClient,
    enforcerAddress:
      ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    delegationManager: ctx.meta.environment.DelegationManager,
    delegationHash: mission.rootDelegationHash,
  });
}

describe("x402 exact ERC-7710 flow (real contracts, local EVM)", () => {
  it("rejects a forged payer or network before consuming the signed permission", async () => {
    const store = new Store(":memory:");
    try {
      const harness = createX402Harness(ctx, store);
      const mission = await createTestMission(ctx, store, { redeemer: ctx.meta.relayerAddress });
      const requirements = buildPaymentRequirements(harness.providers.code, harness.serverConfig);
      const helper = createx402DelegationProvider({
        account: ctx.accounts.executor,
        environment: ctx.meta.environment,
        from: ctx.meta.executorAddress,
        parentPermissionContext: [mission.rootDelegation],
        salt: generateSalt(),
        expirySeconds: 300,
        caveats: [{ type: "limitedCalls", limit: 1 }] as never,
        redeemers: { requireRedeemers: true, addresses: [ctx.meta.relayerAddress] },
      });
      const payload = await helper(requirements);
      const forgedPayer = await verifyPayment({
        x402Version: 2,
        paymentRequirements: requirements,
        paymentPayload: { x402Version: 2, accepted: requirements, payload: { ...payload, delegator: ctx.meta.attackerAddress } },
      }, harness.facilitator);
      expect(forgedPayer).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
      const wrongNetwork = { ...requirements, network: "eip155:84532" as const };
      const forgedNetwork = await verifyPayment({
        x402Version: 2,
        paymentRequirements: wrongNetwork,
        paymentPayload: { x402Version: 2, accepted: wrongNetwork, payload: payload as unknown as Record<string, unknown> },
      }, harness.facilitator);
      expect(forgedNetwork).toMatchObject({ isValid: false, invalidReason: "invalid_network" });
      expect(await rootSpent(mission)).toBe(0n);
    } finally { store.close(); }
  });
  it("pays 0.02 through 402 -> settle -> data and records a receipt", async () => {
    const store = new Store(":memory:");
    const harness = createX402Harness(ctx, store);
    const mission = await createTestMission(ctx, store, {
      title: "x402 basic",
      redeemer: ctx.meta.relayerAddress,
    });
    const client = agentClient(store, mission, harness);

    const result = await client.requestPaidData("code", {
      address: ctx.meta.tokenAddress,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.facts.isContract).toBe(true);
    expect(Number(result.facts.codeSizeBytes)).toBeGreaterThan(0);
    expect(result.blockNumber).toBeGreaterThan(0);

    expect(await rootSpent(mission)).toBe(usdc("0.02"));
    const receipts = store.listReceipts(mission.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].txHash).toBe(result.txHash);
    const purchases = store.listPurchases(mission.id);
    expect(purchases).toHaveLength(1);
    expect(purchases[0].state).toBe("settled");
    expect(purchases[0].responseHash).toBe(result.responseHash);
    expect(store.listPaymentAttempts(mission.id)[0].state).toBe("settled");
    store.close();
  });

  it("returns the cached result for a repeated paymentId without a second charge", async () => {
    const store = new Store(":memory:");
    const harness = createX402Harness(ctx, store);
    const mission = await createTestMission(ctx, store, {
      title: "x402 idempotency",
      redeemer: ctx.meta.relayerAddress,
    });
    const provider = harness.providers.code;
    const requirements = buildPaymentRequirements(
      provider,
      harness.serverConfig,
    );
    const helper = createx402DelegationProvider({
      account: ctx.accounts.executor,
      environment: ctx.meta.environment,
      from: ctx.meta.executorAddress,
      parentPermissionContext: [mission.rootDelegation],
      salt: generateSalt(),
      expirySeconds: 300,
      caveats: [{ type: "limitedCalls", limit: 1 }] as never,
      redeemers: {
        requireRedeemers: true,
        addresses: [ctx.meta.relayerAddress],
      },
    });
    const erc7710 = await helper(requirements);
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: erc7710 as unknown as Record<string, unknown>,
    };
    const paymentId = "swarm-idempotency-test";
    const headers = {
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload),
      "X-SWARM-PAYMENT-ID": paymentId,
    };
    const observedBlock = Number(await ctx.publicClient.getBlockNumber());
    const url = `${harness.baseUrl}${provider.path}?address=${ctx.meta.tokenAddress}&blockNumber=${observedBlock}`;

    const first = await harness.serve("code", new Request(url, { headers }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      source: { txHash: string };
      facts: Record<string, unknown>;
    };
    expect(await rootSpent(mission)).toBe(usdc("0.02"));

    const second = await harness.serve("code", new Request(url, { headers }));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-swarm-idempotent")).toBe("true");
    const secondBody = (await second.json()) as {
      source: { txHash: string };
      facts: Record<string, unknown>;
    };
    expect(secondBody.source.txHash).toBe(firstBody.source.txHash);
    expect(secondBody.facts).toEqual(firstBody.facts);
    expect.soft(secondBody).toEqual(firstBody);

    // A different signed root cannot reuse another mission's receipt.
    const otherMission = await createTestMission(ctx, store, {
      title: "other mission",
      redeemer: ctx.meta.relayerAddress,
    });
    const otherHelper = createx402DelegationProvider({
      account: ctx.accounts.executor,
      environment: ctx.meta.environment,
      from: ctx.meta.executorAddress,
      parentPermissionContext: [otherMission.rootDelegation],
      salt: generateSalt(),
      expirySeconds: 300,
      caveats: [{ type: "limitedCalls", limit: 1 }] as never,
      redeemers: { requireRedeemers: true, addresses: [ctx.meta.relayerAddress] },
    });
    const otherPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: (await otherHelper(requirements)) as unknown as Record<string, unknown>,
    };
    const crossMissionReplay = await harness.serve("code", new Request(url, {
      headers: {
        ...headers,
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(otherPayload),
      },
    }));
    expect(crossMissionReplay.status).toBe(409);
    expect(await rootSpent(otherMission)).toBe(0n);

    // No new charge: one purchase, one on-chain spend, no second payment attempt.
    expect(await rootSpent(mission)).toBe(usdc("0.02"));
    expect(store.listPurchases(mission.id)).toHaveLength(1);
    expect(store.listPaymentAttempts(mission.id)).toHaveLength(0);

    // A different request under the same paymentId is a conflict, never a charge.
    const conflict = await harness.serve(
      "code",
      new Request(
        `${harness.baseUrl}${provider.path}?address=${ctx.meta.environment.DelegationManager}`,
        { headers },
      ),
    );
    expect(conflict.status).toBe(409);
    expect(await rootSpent(mission)).toBe(usdc("0.02"));
    store.close();
  });

  it("refuses the third 0.02 purchase when only 0.01 is left in the shared budget", async () => {
    const store = new Store(":memory:");
    const harness = createX402Harness(ctx, store);
    const mission = await createTestMission(ctx, store, {
      title: "x402 third refusal",
      redeemer: ctx.meta.relayerAddress,
    });
    const client = agentClient(store, mission, harness);

    const first = await client.requestPaidData("code", {
      address: ctx.meta.tokenAddress,
    });
    expect(first.ok).toBe(true);
    const second = await client.requestPaidData("code", {
      address: ctx.meta.environment.DelegationManager,
    });
    expect(second.ok).toBe(true);

    const before = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: ctx.meta.recipient1,
    });
    const third = await client.requestPaidData("code", {
      address: ctx.meta.recipient2,
    });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.state).toBe("rejected");
    expect(third.reason).toMatch(/insufficient_funds|allowance-exceeded/i);

    expect(await rootSpent(mission)).toBe(usdc("0.04"));
    const after = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: ctx.meta.recipient1,
    });
    expect(after - before).toBe(0n);
    const purchases = store.listPurchases(mission.id);
    expect(purchases.map((purchase) => purchase.state)).toEqual([
      "settled",
      "settled",
      "rejected",
    ]);
    store.close();
  });

  it("validates provider input before any payment", async () => {
    const store = new Store(":memory:");
    const harness = createX402Harness(ctx, store);
    const response = await harness.serve(
      "code",
      new Request(`${harness.baseUrl}/api/providers/code?address=not-an-address`),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    store.close();
  });
});
