import { beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { Store } from "@/store";
import { parseAmount } from "@/shared/amounts";
import { PolicyError } from "@/shared/errors";
import { createUserSmartAccount, deploySmartAccount } from "@/payments/accounts";
import { readDelegationSpent, readTokenBalance } from "@/payments/spend";
import { delegationHash } from "@/payments/permissions";
import { revokeMissionRoot } from "@/payments/revocation";
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

async function rootSpent(missionRootHash: Hex): Promise<bigint> {
  return readDelegationSpent({
    publicClient: ctx.publicClient,
    enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    delegationManager: ctx.meta.environment.DelegationManager,
    delegationHash: missionRootHash,
  });
}

describe("on-chain payment guards", () => {
  it("rejects a recipient outside the mission allow-list", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "recipient allow-list",
    });
    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.01"),
      exactCalldata: false,
    });

    const before = await rootSpent(mission.rootDelegationHash);
    await expect(
      redeemTestChild(ctx, mission, child, {
        recipient: ctx.meta.attackerAddress,
        amount: usdc("0.01"),
      }),
    ).rejects.toThrow(/RecipientNotAllowed|not allowed/i);
    expect(await rootSpent(mission.rootDelegationHash)).toBe(before);

    const attackerBalance = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: ctx.meta.attackerAddress,
    });
    expect(attackerBalance).toBe(0n);
    store.close();
  });

  it("rejects a payment above the mission per-call cap even if a child is crafted wider", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "per-call cap at the root",
    });

    // Bypass the SDK attenuation with a custom child whose own scope allows
    // 0.03, then try to spend 0.03 in one call. The root policy caveat still
    // caps the call at 0.02.
    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.03"),
      perCallMaxOverride: usdc("0.03"),
    });
    const before = await rootSpent(mission.rootDelegationHash);
    await expect(
      redeemTestChild(ctx, mission, child, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.03"),
      }),
    ).rejects.toThrow(/PerCallCapExceeded|per-call|MissionPolicyEnforcer/i);
    expect(await rootSpent(mission.rootDelegationHash)).toBe(before);

    // The UX layer rejects it before anything is signed as well.
    const service = createPaymentService(ctx, store);
    await expect(
      service.execute({
        missionId: mission.id,
        recipient: ctx.meta.recipient1,
        amount: usdc("0.03"),
      }),
    ).rejects.toThrow(/per-call cap/);
    const attempts = store.listPaymentAttempts(mission.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe("rejected");
    store.close();
  });

  it("rejects a value above the child's own cumulative cap", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "child cap",
    });
    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.025"),
      exactCalldata: false,
      // child scope/caveat stays at the mission per-call max (0.02)
    });
    await expect(
      redeemTestChild(ctx, mission, child, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.025"),
      }),
    ).rejects.toThrow(/allowance-exceeded/i);
    expect(await rootSpent(mission.rootDelegationHash)).toBe(0n);
    store.close();
  });

  it("rejects an expired child permission", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "expiry",
    });
    const now = Math.floor(Date.now() / 1000);
    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.01"),
      now: now - 120,
      validUntil: now - 60,
    });
    await expect(
      redeemTestChild(ctx, mission, child, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.01"),
      }),
    ).rejects.toThrow(/TimestampEnforcer|expired/i);
    expect(await rootSpent(mission.rootDelegationHash)).toBe(0n);
    store.close();
  });

  it("does not allow replaying a one-shot child permission", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "one-shot",
    });
    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });

    const recipientBefore = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: ctx.meta.recipient1,
    });

    await redeemTestChild(ctx, mission, child, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    await expect(
      redeemTestChild(ctx, mission, child, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.02"),
      }),
    ).rejects.toThrow(PolicyError);

    const recipientAfter = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: ctx.meta.recipient1,
    });
    expect(recipientAfter - recipientBefore).toBe(usdc("0.02"));
    expect(await rootSpent(mission.rootDelegationHash)).toBe(usdc("0.02"));
    store.close();
  });

  it("rejects a revoked root delegation", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "revocation",
    });

    const revokeTx = await revokeMissionRoot({
      store,
      publicClient: ctx.publicClient,
      walletClient: ctx.executorWallet,
      smartAccount: ctx.smartAccount,
      entryPoint: ctx.meta.environment.EntryPoint,
      beneficiary: ctx.meta.executorAddress,
      delegationManager: ctx.meta.environment.DelegationManager,
      missionId: mission.id,
    });
    expect(revokeTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(store.getMission(mission.id).status).toBe("revoked");

    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.01"),
    });
    await expect(
      redeemTestChild(ctx, mission, child, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.01"),
      }),
    ).rejects.toThrow(/DisabledDelegation|disabled/i);
    expect(await rootSpent(mission.rootDelegationHash)).toBe(0n);

    const service = createPaymentService(ctx, store);
    await expect(
      service.execute({
        missionId: mission.id,
        recipient: ctx.meta.recipient1,
        amount: usdc("0.01"),
      }),
    ).rejects.toThrow(/revoked/);
    store.close();
  });

  it("classifies an execution revert as failed without increasing spend", async () => {
    // A second smart account with the same owner but zero USDC: every caveat
    // passes and the token transfer itself fails.
    const secondSmartAccount = await createUserSmartAccount({
      publicClient: ctx.publicClient,
      owner: ctx.accounts.owner,
      environment: ctx.meta.environment,
      deploySalt: `0x${"01".repeat(32)}` as Hex,
    });
    await deploySmartAccount({
      publicClient: ctx.publicClient,
      walletClient: ctx.executorWallet,
      smartAccount: secondSmartAccount,
    });

    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, {
      title: "empty account",
      smartAccount: secondSmartAccount,
    });

    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    const recipientBefore = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: ctx.meta.recipient1,
    });

    await expect(
      redeemTestChild(ctx, mission, child, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.02"),
      }),
    ).rejects.toThrow(/insufficient-balance/i);

    expect(await rootSpent(mission.rootDelegationHash)).toBe(0n);
    const recipientAfter = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: ctx.meta.recipient1,
    });
    expect(recipientAfter).toBe(recipientBefore);
    store.close();
  });

  it("keeps the MissionPolicyEnforcer spend independent of the root budget", async () => {
    const store = new Store(":memory:");
    const mission = await createTestMission(ctx, store, { title: "spend map" });
    const child = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.01"),
    });
    expect(
      await readDelegationSpent({
        publicClient: ctx.publicClient,
        enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
        delegationManager: ctx.meta.environment.DelegationManager,
        delegationHash: delegationHash(child),
      }),
    ).toBe(0n);
    await redeemTestChild(ctx, mission, child, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.01"),
    });
    expect(
      await readDelegationSpent({
        publicClient: ctx.publicClient,
        enforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
        delegationManager: ctx.meta.environment.DelegationManager,
        delegationHash: delegationHash(child),
      }),
    ).toBe(usdc("0.01"));
    expect(getAddress(ctx.meta.recipient1)).toBe(ctx.meta.recipient1);
    store.close();
  });
});
