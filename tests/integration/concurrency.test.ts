import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "@/store";
import { parseAmount } from "@/shared/amounts";
import { PolicyError } from "@/shared/errors";
import { readDelegationSpent } from "@/payments/spend";
import {
  createPaymentService,
  createTestContext,
  createTestMission,
  type TestContext,
} from "../harness/context";

const usdc = (value: string) => parseAmount(value, 6);

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

describe("concurrent payments against one budget", () => {
  it("lets exactly one of two racing 0.02 payments settle when only 0.03 remains", async () => {
    const store = new Store(":memory:");
    const service = createPaymentService(ctx, store);
    const mission = await createTestMission(ctx, store, {
      title: "concurrency",
      budget: usdc("0.05"),
      perCallMax: usdc("0.02"),
    });

    // Spend 0.02 first, leaving 0.03 on the shared budget.
    const seed = await service.execute({
      missionId: mission.id,
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    expect(seed.state).toBe("settled");

    // Both attempts pass the server-side check individually.
    const preparedA = await service.prepare({
      missionId: mission.id,
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    const preparedB = await service.prepare({
      missionId: mission.id,
      recipient: ctx.meta.recipient2,
      amount: usdc("0.02"),
    });

    // Submit without simulation, with explicit consecutive nonces, in parallel.
    const baseNonce = await ctx.publicClient.getTransactionCount({
      address: ctx.meta.executorAddress,
      blockTag: "pending",
    });
    const results = await Promise.allSettled([
      service.submit(preparedA, {
        simulate: false,
        nonce: baseNonce,
        gas: 3_000_000n,
      }),
      service.submit(preparedB, {
        simulate: false,
        nonce: baseNonce + 1,
        gas: 3_000_000n,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /allowance-exceeded/i,
    );

    const onchainSpent = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
    expect(onchainSpent).toBe(usdc("0.04"));
    expect(onchainSpent).toBeLessThanOrEqual(mission.policy.budget);

    const attempts = store.listPaymentAttempts(mission.id);
    const states = attempts.map((attempt) => attempt.state).sort();
    expect(states).toEqual(["rejected", "settled", "settled"]);
    const rejectedAttempt = attempts.find(
      (attempt) => attempt.state === "rejected",
    );
    expect(rejectedAttempt?.errorKind).toBe("policy");
    expect(store.computeMissionSpent(mission.id)).toBe(usdc("0.04"));

    // A rejected concurrent attempt is a policy refusal, not an infrastructure error.
    const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedError).toBeInstanceOf(PolicyError);

    store.close();
  });
});
