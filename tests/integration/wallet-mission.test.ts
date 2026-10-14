import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Store } from "@/store";
import { loadAppRuntime, type AppRuntime } from "@/payments/runtime";
import { prepareWalletMission, submitWalletMission } from "@/missions/service";
import { signBrowserPayload } from "../harness/browser-signature";
import { X402AgentClient } from "@/x402/client";
import { createX402Harness } from "../harness/x402";
import { createMissionSchema } from "@/shared/schemas";
import { CONTEXT_FILE } from "../harness/local-chain";
import { createTestContext, type TestContext } from "../harness/context";

let ctx: TestContext;
let runtime: AppRuntime;

beforeAll(async () => {
  ctx = await createTestContext();
  runtime = loadAppRuntime({
    NODE_ENV: "test",
    SWARM_TAB_NETWORK: "local",
    LOCAL_CHAIN_CONTEXT: fileURLToPath(CONTEXT_FILE),
  });
});

describe("wallet mission preparation and HTTP-shaped submission", () => {
  it("accepts a JSON round trip and schema-parsed owner-signed delegation", async () => {
    const store = new Store(":memory:");
    const input = {
      title: "wallet transport regression",
      task: "Inspect the contract",
      addresses: [ctx.meta.tokenAddress],
      budgetUsdc: "0.05",
    };
    try {
      const prepared = await prepareWalletMission({ runtime, input, ownerAddress: ctx.accounts.owner.address });
      const signature = signBrowserPayload(prepared.typedData);
      const submitted = createMissionSchema.parse(JSON.parse(JSON.stringify({
        ...input,
        mode: "wallet",
        ownerAddress: prepared.ownerAddress,
        delegation: prepared.delegation,
        signature,
      })));
      if (submitted.mode !== "wallet") throw new Error("wrong mode");
      const mission = await submitWalletMission({ runtime, store, ...submitted, input });
      expect(mission.status).toBe("active");
      expect(mission.policy.budget).toBe(50_000n);
      expect(mission.policy.perCallMax).toBe(20_000n);
      const repeated = await submitWalletMission({ runtime, store, ...submitted, input });
      expect(repeated.id).toBe(mission.id);
      expect(store.listMissions()).toHaveLength(1);
      const harness = createX402Harness(ctx, store);
      const client = new X402AgentClient({
        store, mission, publicClient: ctx.publicClient, executor: ctx.accounts.executor,
        environment: ctx.meta.environment, chainId: ctx.meta.chainId,
        relayerAddress: ctx.meta.relayerAddress,
        token: { address: ctx.meta.tokenAddress, symbol: "USDC", decimals: 6 },
        budgetEnforcerAddress: ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
        providers: harness.providers, baseUrl: harness.baseUrl, fetchImpl: harness.fetchImpl,
      });
      const payment = await client.requestPaidData("code", { address: ctx.meta.tokenAddress });
      expect(payment.ok).toBe(true);
      expect(store.listPurchases(mission.id)[0].state).toBe("settled");
    } finally { store.close(); }
  });

  it("rejects an owner signature made for a different chain or verifier", async () => {
    const store = new Store(":memory:");
    const input = { title: "wrong signing domain", task: "Inspect code", addresses: [ctx.meta.tokenAddress], budgetUsdc: "0.05" };
    try {
      const prepared = await prepareWalletMission({ runtime, input, ownerAddress: ctx.accounts.owner.address });
      for (const domain of [
        { ...prepared.typedData.domain, chainId: 84532 },
        { ...prepared.typedData.domain, verifyingContract: ctx.meta.attackerAddress },
      ]) {
        const signature = signBrowserPayload({ ...prepared.typedData, domain });
        await expect(submitWalletMission({
          runtime, store, input, ownerAddress: prepared.ownerAddress,
          delegation: prepared.delegation, signature,
        })).rejects.toThrow(/owner signature.*invalid/i);
      }
      expect(store.listMissions()).toHaveLength(0);
    } finally { store.close(); }
  });
});
