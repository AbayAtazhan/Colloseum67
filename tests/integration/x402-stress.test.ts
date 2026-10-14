import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "@/store";
import { parseAmount } from "@/shared/amounts";
import { X402AgentClient } from "@/x402/client";
import { readDelegationSpent } from "@/payments/spend";
import {
  createTestContext,
  createTestMission,
  type TestContext,
} from "../harness/context";
import { createX402Harness } from "../harness/x402";

const usdc = (value: string) => parseAmount(value, 6);

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

/**
 * Contract-path stress test, deliberately independent of the LLM: three
 * concurrent x402 purchases of 0.02 against a 0.05 budget. Only two may
 * settle, because the root ERC20TransferAmountEnforcer is the source of truth.
 */
describe("x402 concurrent budget stress (no LLM)", () => {
  it("settles at most two of three concurrent 0.02 purchases", async () => {
    const store = new Store(":memory:");
    const harness = createX402Harness(ctx, store);
    const mission = await createTestMission(ctx, store, {
      title: "x402 concurrency",
      redeemer: ctx.meta.relayerAddress,
    });
    const client = new X402AgentClient({
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

    const results = await Promise.all([
      client.requestPaidData("code", { address: ctx.meta.tokenAddress }),
      client.requestPaidData("code", {
        address: ctx.meta.environment.DelegationManager,
      }),
      client.requestPaidData("code", { address: ctx.meta.recipient2 }),
    ]);

    const settled = results.filter((result) => result.ok);
    const rejected = results.filter(
      (result) => !result.ok && result.state === "rejected",
    );
    expect(settled).toHaveLength(2);
    expect(rejected).toHaveLength(1);

    const spent = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress:
        ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
    expect(spent).toBe(usdc("0.04"));
    expect(spent).toBeLessThanOrEqual(mission.policy.budget);

    const purchases = store.listPurchases(mission.id);
    expect(purchases.filter((purchase) => purchase.state === "settled")).toHaveLength(2);
    expect(
      purchases.filter((purchase) => purchase.state === "rejected"),
    ).toHaveLength(1);
    // Each settled purchase has exactly one distinct transaction.
    const hashes = purchases
      .filter((purchase) => purchase.state === "settled")
      .map((purchase) => purchase.txHash);
    expect(new Set(hashes).size).toBe(2);
    store.close();
  });
});
