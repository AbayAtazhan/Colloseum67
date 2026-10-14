import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "@/store";
import { formatAmountShort, parseAmount } from "@/shared/amounts";
import { PolicyError } from "@/shared/errors";
import { readDelegationSpent, readTokenBalance } from "@/payments/spend";
import { delegationHash } from "@/payments/permissions";
import {
  createPaymentService,
  createTestContext,
  createTestMission,
  redeemTestChild,
  signTestChild,
  type TestContext,
} from "../harness/context";

const usdc = (value: string) => parseAmount(value, 6);

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

describe("shared mission budget (real DelegationManager, local EVM)", () => {
  it("settles two 0.02 payments and rejects the third against the 0.05 root cap", async () => {
    const store = new Store(":memory:");
    const service = createPaymentService(ctx, store);
    const mission = await createTestMission(ctx, store, {
      title: "0.05 budget / 0.02 per call",
      budget: usdc("0.05"),
      perCallMax: usdc("0.02"),
    });

    const [userBefore, r1Before, r2Before] = await Promise.all([
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.smartAccount.address,
      }),
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.meta.recipient1,
      }),
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.meta.recipient2,
      }),
    ]);

    const first = await service.execute({
      missionId: mission.id,
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    expect(first.state).toBe("settled");
    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const second = await service.execute({
      missionId: mission.id,
      recipient: ctx.meta.recipient2,
      amount: usdc("0.02"),
    });
    expect(second.state).toBe("settled");

    const spentAfterTwo = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
    expect(spentAfterTwo).toBe(usdc("0.04"));

    // Third payment through the service: rejected by the server-side UX guard.
    await expect(
      service.execute({
        missionId: mission.id,
        recipient: ctx.meta.recipient1,
        amount: usdc("0.02"),
      }),
    ).rejects.toThrow(PolicyError);
    const states = store
      .listPaymentAttempts(mission.id)
      .map((attempt) => attempt.state);
    expect(states).toEqual(["settled", "settled", "rejected"]);

    // Third payment bypassing the server guard: rejected by the contract.
    const thirdChild = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    await expect(
      redeemTestChild(ctx, mission, thirdChild, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.02"),
      }),
    ).rejects.toThrow(/allowance-exceeded/);

    const spentAfterThird = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
    expect(spentAfterThird).toBe(usdc("0.04"));

    const [userAfter, r1After, r2After] = await Promise.all([
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.smartAccount.address,
      }),
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.meta.recipient1,
      }),
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.meta.recipient2,
      }),
    ]);
    expect(r1After - r1Before).toBe(usdc("0.02"));
    expect(r2After - r2Before).toBe(usdc("0.02"));
    expect(userBefore - userAfter).toBe(usdc("0.04"));

    store.close();
  });

  it("a brand-new child delegation does not reset the shared spend", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "no reset",
      budget: usdc("0.05"),
      perCallMax: usdc("0.02"),
    });

    const childA = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    await redeemTestChild(ctx, mission, childA, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });

    const childB = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient2,
      amount: usdc("0.02"),
    });

    // The new child starts from zero locally...
    const childSpentB = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: delegationHash(childB),
    });
    expect(childSpentB).toBe(0n);

    // ...but the root (mission) spend is unchanged and keeps accruing.
    const rootSpentBefore = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
    expect(rootSpentBefore).toBe(usdc("0.02"));

    await redeemTestChild(ctx, mission, childB, {
      recipient: ctx.meta.recipient2,
      amount: usdc("0.02"),
    });

    const rootSpentAfter = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
    expect(rootSpentAfter).toBe(usdc("0.04"));
    expect(formatAmountShort(rootSpentAfter, 6)).toBe("0.04");

    store.close();
  });
});
