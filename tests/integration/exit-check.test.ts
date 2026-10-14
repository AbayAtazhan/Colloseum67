import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { Store } from "@/store";
import { loadAppRuntime, type AppRuntime } from "@/payments/runtime";
import { createLocalMission, prepareWalletMission, submitWalletMission } from "@/missions/service";
import { runMissionScenario } from "@/agents/orchestrator";
import { FixtureLlmClient } from "@/agents/llm";
import { EXIT_DEMO_ADDRESSES, EXIT_DEMO_TASK } from "@/shared/exit-check";
import { CONTEXT_FILE } from "../harness/local-chain";
import { createTestContext, type TestContext } from "../harness/context";
import { createX402Harness } from "../harness/x402";
import { marketDataFetch } from "../harness/market-data";
import { signBrowserPayload } from "../harness/browser-signature";

let ctx: TestContext;
let runtime: AppRuntime;
beforeAll(async () => {
  ctx = await createTestContext();
  runtime = loadAppRuntime({ NODE_ENV: "test", SWARM_TAB_NETWORK: "local", LOCAL_CHAIN_CONTEXT: fileURLToPath(CONTEXT_FILE) });
});
const input = { title: "Token exit check", task: EXIT_DEMO_TASK, addresses: EXIT_DEMO_ADDRESSES,
  scenario: "exit-check" as const, positionUsd: "100", budgetUsdc: "0.05" };

describe("two-agent token exit check through real x402 settlements", () => {
  it("pays for both comparisons, blocks depth on chain and reports only settled evidence", async () => {
    const store = new Store(":memory:");
    try {
      const source = marketDataFetch();
      const harness = createX402Harness(ctx, store, source.fetchImpl);
      const mission = await createLocalMission({ runtime, store, input });
      expect(store.listEvents(mission.id).find((event) => event.type === "mission.context")?.payload)
        .toMatchObject({ scenario: "exit-check", positionUsd: "100", addresses: EXIT_DEMO_ADDRESSES.map((address) => getAddress(address)) });
      const report = await runMissionScenario({ missionId: mission.id, ...input,
        deps: { store, runtime, llm: new FixtureLlmClient(), publicClient: ctx.publicClient,
          baseUrl: harness.baseUrl, paidFetch: harness.fetchImpl } });
      expect(report.budget.spent).toBe("40000"); expect(report.budget.remaining).toBe("10000");
      expect(report.sources).toHaveLength(2); expect(report.refusals).toHaveLength(1);
      expect(report.sources.every((item) => item.blockNumber === null && Number(item.settlementBlockNumber) > 0)).toBe(true);
      expect(report.exitCheck?.depthCheck).toBe("budget_blocked");
      expect(report.exitCheck?.tokens.map((token) => token.exit?.quotedUsdc)).toEqual(["98", "98"]);
      expect(report.exitCheck?.tokens.every((token) => token.paymentIds.length === 2)).toBe(true);
      expect(source.seen).toHaveLength(7); // No source fetches for the refused depth purchase.
      expect(store.listPurchases(mission.id).map((item) => item.state)).toEqual(["settled", "settled", "rejected"]);
      expect(store.listLlmCalls(mission.id).every((call) => call.fixture)).toBe(true);
    } finally { store.close(); }
  });
  it("binds retries to the registered scenario and position size", async () => {
    const store = new Store(":memory:");
    try {
      const prepared = await prepareWalletMission({ runtime, input, ownerAddress: ctx.accounts.owner.address });
      const submission = { runtime, store, input, ownerAddress: prepared.ownerAddress,
        delegation: prepared.delegation, signature: signBrowserPayload(prepared.typedData) };
      const mission = await submitWalletMission(submission);
      expect((await submitWalletMission(submission)).id).toBe(mission.id);
      await expect(submitWalletMission({ ...submission, input: { ...input, positionUsd: "1000" } })).rejects.toThrow(/different mission task/);
      await expect(submitWalletMission({ ...submission, input: { ...input, scenario: "research" } })).rejects.toThrow(/different mission task/);
    } finally { store.close(); }
  });
});
