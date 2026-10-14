import { getAddress, type Address } from "viem";
import type { Store } from "@/store";
import { X402AgentClient } from "@/x402/client";
import { readDelegationSpent } from "@/payments/spend";
import type { AppRuntime } from "@/payments/runtime";
import { createLocalMission } from "./service";

export interface StressResult {
  missionId: string;
  rootDelegationHash: string;
  requests: number;
  settled: number;
  rejected: number;
  failed: number;
  onchainSpent: string;
  budget: string;
  perCallMax: string;
  results: Array<{
    providerId: string;
    state: "settled" | "rejected" | "failed";
    txHash: string | null;
    reason: string | null;
  }>;
}

/**
 * Contract budget stress test, fully independent of the LLM: it creates a
 * fresh mission and fires `count` concurrent paid HTTP requests through the
 * real x402 path. With a 0.05 budget and 0.02 per call, at most two settle;
 * the contract, not the server, decides which ones.
 */
export async function runContractStressTest(params: {
  runtime: AppRuntime;
  store: Store;
  baseUrl: string;
  address: Address;
  count?: number;
}): Promise<StressResult> {
  const { runtime, store } = params;
  const count = params.count ?? 3;
  const address = getAddress(params.address);
  const mission = await createLocalMission({
    runtime,
    store,
    input: {
      title: "Policy stress test (no LLM)",
      task: "Contract budget stress test: concurrent x402 purchases without any LLM involvement.",
      addresses: [address],
    },
  });
  const client = new X402AgentClient({
    store,
    mission,
    publicClient: runtime.publicClient,
    executor: runtime.executor!,
    environment: runtime.environment,
    chainId: runtime.config.chainId,
    relayerAddress: runtime.config.relayerAddress!,
    token: runtime.config.token,
    budgetEnforcerAddress: runtime.config.budgetEnforcerAddress,
    providers: runtime.providers,
    baseUrl: params.baseUrl,
  });
  const outcomes = await Promise.all(
    Array.from({ length: count }, () =>
      client.requestPaidData("code", { address }),
    ),
  );
  let onchainSpent: bigint | null = null;
  try {
    onchainSpent = await readDelegationSpent({
      publicClient: runtime.publicClient,
      enforcerAddress: runtime.config.budgetEnforcerAddress,
      delegationManager: runtime.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
  } catch {
    onchainSpent = store.computeMissionSpent(mission.id);
  }
  return {
    missionId: mission.id,
    rootDelegationHash: mission.rootDelegationHash,
    requests: count,
    settled: outcomes.filter((outcome) => outcome.ok).length,
    rejected: outcomes.filter((outcome) => !outcome.ok && outcome.state === "rejected")
      .length,
    failed: outcomes.filter((outcome) => !outcome.ok && outcome.state === "failed")
      .length,
    onchainSpent: (onchainSpent ?? 0n).toString(),
    budget: mission.policy.budget.toString(),
    perCallMax: mission.policy.perCallMax.toString(),
    results: outcomes.map((outcome) => ({
      providerId: outcome.providerId,
      state: outcome.ok ? ("settled" as const) : outcome.state,
      txHash: outcome.ok ? outcome.txHash : null,
      reason: outcome.ok ? null : outcome.reason,
    })),
  };
}
