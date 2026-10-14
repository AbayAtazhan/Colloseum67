import { beforeAll, describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { Store } from "@/store";
import { parseAmount } from "@/shared/amounts";
import type { MissionPolicy } from "@/shared/types";
import { createUserSmartAccount } from "@/payments/accounts";
import {
  buildRootDelegation,
  delegationHash,
  signDelegationWithAccount,
} from "@/payments/permissions";
import { ensureLocalSpendingFunds } from "@/payments/local-funding";
import { buildUserOperationTypedData } from "@/payments/userop";
import { readDelegationSpent, readTokenBalance } from "@/payments/spend";
import {
  prepareMissionRevocation,
  signRevocationWithAccount,
  submitMissionRevocation,
  type RevocationContext,
} from "@/missions/revoke";
import { X402AgentClient } from "@/x402/client";
import {
  createTestContext,
  type TestContext,
} from "../harness/context";
import { createX402Harness } from "../harness/x402";
import { signBrowserPayload } from "../harness/browser-signature";

const usdc = (value: string) => parseAmount(value, 6);

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

function revocationContext(store: Store): RevocationContext {
  return {
    store,
    publicClient: ctx.publicClient,
    walletClient: ctx.deployerWallet,
    beneficiary: ctx.accounts.deployer.address,
    entryPoint: ctx.meta.environment.EntryPoint,
    chainId: ctx.meta.chainId,
    environment: ctx.meta.environment,
  };
}

/** Creates a root delegation as a wallet owner would: the owner signs locally. */
async function createWalletSignedMission(
  store: Store,
  options: { owner?: typeof ctx.accounts.owner } = {},
) {
  const owner = options.owner ?? ctx.accounts.owner;
  const smartAccount = await createUserSmartAccount({
    publicClient: ctx.publicClient,
    owner,
    environment: ctx.meta.environment,
  });
  const latest = await ctx.publicClient.getBlock();
  const policy: MissionPolicy = {
    chainId: ctx.meta.chainId,
    token: { address: ctx.meta.tokenAddress, symbol: "USDC", decimals: 6 },
    budget: usdc("0.05"),
    perCallMax: usdc("0.02"),
    recipients: [ctx.meta.recipient1, ctx.meta.recipient2],
    validAfter: 0,
    validBefore: Number(latest.timestamp) + 3600,
    redeemer: ctx.meta.relayerAddress,
  };
  const unsigned = buildRootDelegation({
    environment: ctx.meta.environment,
    from: smartAccount.address,
    to: ctx.meta.executorAddress,
    policy,
    enforcerAddress: ctx.meta.enforcerAddress,
  });
  const signed = await signDelegationWithAccount(
    owner,
    unsigned,
    ctx.meta.chainId,
    ctx.meta.environment.DelegationManager,
  );
  const mission = store.createMission({
    title: "wallet-signed revocation test",
    context: { task: "revocation flow", addresses: [ctx.meta.tokenAddress] },
    policy,
    ownerAddress: owner.address,
    smartAccountAddress: smartAccount.address,
    executorAddress: ctx.meta.executorAddress,
    rootDelegation: signed,
    rootDelegationHash: delegationHash(signed),
    enforcerAddress: ctx.meta.enforcerAddress,
  });
  return mission;
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

describe("owner-authorized revocation (browser userOp path, no server owner key)", () => {
  it("revokes after a successful payment, then the next payment is refused by the revoked permission", async () => {
    const store = new Store(":memory:");
    const harness = createX402Harness(ctx, store);
    // ctx.smartAccount is the well-funded bootstrap account owned by
    // ctx.accounts.owner; the mission root is signed by that owner exactly the
    // way MetaMask would sign it (eth_signTypedData_v4 over the same payload).
    const mission = await createWalletSignedMission(store, {
      owner: ctx.accounts.owner,
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

    // 1) an allowed payment passes before revocation
    const first = await client.requestPaidData("code", {
      address: ctx.meta.tokenAddress,
    });
    expect(first.ok).toBe(true);
    expect(await rootSpent(mission)).toBe(usdc("0.02"));

    // 2) the owner signs the revocation user operation (MetaMask equivalent)
    const revocation = revocationContext(store);
    const prepared = await prepareMissionRevocation(revocation, mission.id);
    expect(prepared.ownerAddress).toBe(ctx.meta.ownerAddress);
    // The prepare response is serialized to the browser as JSON; bigints would
    // break the MetaMask signing payload.
    expect(() => JSON.stringify(prepared)).not.toThrow();
    const signature = signBrowserPayload(prepared.userOp.typedData);
    const txHash = await submitMissionRevocation(revocation, {
      missionId: mission.id,
      userOp: prepared.userOp,
      signature,
    });
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(store.getMission(mission.id).status).toBe("revoked");
    expect(
      store
        .listEvents(mission.id)
        .some((event) => event.type === "mission.revoke.confirmed"),
    ).toBe(true);

    // 3) the remaining budget (0.03) is untouched, but the permission is gone:
    // the next payment must be refused because of the revocation, not the budget.
    const second = await client.requestPaidData("code", {
      address: ctx.meta.environment.DelegationManager,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.state).toBe("rejected");
      expect(second.reason).toMatch(/disabled|invalid_transaction_state/i);
      expect(second.reason).not.toMatch(/insufficient_funds|budget/i);
    }
    expect(await rootSpent(mission)).toBe(usdc("0.02"));
    store.close();
  });

  it("rejects a tampered revocation call and a foreign signature", async () => {
    const store = new Store(":memory:");
    const mission = await createWalletSignedMission(store, {
      owner: ctx.accounts.owner,
    });
    const revocation = revocationContext(store);
    const prepared = await prepareMissionRevocation(revocation, mission.id);
    const signature = await signRevocationWithAccount(
      ctx.accounts.owner,
      prepared,
    );

    await expect(
      submitMissionRevocation(revocation, {
        missionId: mission.id,
        userOp: { ...prepared.userOp, callData: "0x1234" },
        signature,
      }),
    ).rejects.toThrow(/disable/i);

    const foreign = await signRevocationWithAccount(
      ctx.accounts.attacker,
      prepared,
    );
    await expect(
      submitMissionRevocation(revocation, {
        missionId: mission.id,
        userOp: prepared.userOp,
        signature: foreign,
      }),
    ).rejects.toThrow(/signature/i);
    expect(store.getMission(mission.id).status).toBe("active");
    store.close();
  });

  it("auto-funds a fresh spending account with at least 1 USDC and ETH for prefunds", async () => {
    const owner = ctx.accounts.recipient2;
    const smartAccount = await createUserSmartAccount({
      publicClient: ctx.publicClient,
      owner,
      environment: ctx.meta.environment,
    });
    const before = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: smartAccount.address,
    });
    expect(before).toBe(0n);

    const funded = await ensureLocalSpendingFunds({
      mode: "local",
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      deployerWallet: ctx.deployerWallet,
      smartAccountAddress: smartAccount.address,
    });
    expect(funded.actions.length).toBeGreaterThan(0);
    expect(funded.usdcBalance).toBeGreaterThanOrEqual(usdc("1"));
    expect(funded.ethBalance).toBeGreaterThanOrEqual(parseEther("0.5"));

    const after = await readTokenBalance({
      publicClient: ctx.publicClient,
      token: ctx.meta.tokenAddress,
      account: smartAccount.address,
    });
    expect(after).toBeGreaterThanOrEqual(usdc("1"));
  });

  it("does not mark a permission revoked when the inner user operation fails", async () => {
    const store = new Store(":memory:");
    try {
      const mission = await createWalletSignedMission(store);
      const revocation = revocationContext(store);
      // A relayer using an explicit outer gas limit bypasses eth_estimateGas's
      // inner-OOG guard. The receipt must still reject a failed account call.
      revocation.walletClient = {
        ...ctx.deployerWallet,
        sendTransaction: (parameters) => ctx.deployerWallet.sendTransaction({ ...parameters, gas: 3_000_000n } as never),
      };
      const prepared = await prepareMissionRevocation(revocation, mission.id);
      const operation = { ...prepared.userOp, callGasLimit: "0" };
      const signature = await signRevocationWithAccount(ctx.accounts.owner, {
        ...prepared,
        userOp: { ...operation, typedData: buildUserOperationTypedData(operation, { chainId: ctx.meta.chainId }) },
      });
      await expect(submitMissionRevocation(revocation, {
        missionId: mission.id, userOp: operation, signature,
      })).rejects.toThrow(/failed inside EntryPoint/i);
      expect(store.getMission(mission.id).status).toBe("active");
      expect(store.listEvents(mission.id).some((event) => event.type === "mission.revoke.confirmed")).toBe(false);
    } finally { store.close(); }
  });
});
