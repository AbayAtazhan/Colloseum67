import type { Address } from "viem";
import type { Store } from "@/store";
import type { MissionReport, MissionRecord, Purchase } from "@/shared/types";
import type { ReadClient } from "@/payments/clients";
import type { AppRuntime } from "@/payments/runtime";
import { X402AgentClient } from "@/x402/client";
import { readDelegationSpent } from "@/payments/spend";
import { ACTIVITY_ANALYST, CODE_ANALYST, MARKET_ANALYST, EXIT_ANALYST, runAgent, type AgentRunOutcome } from "./agent";
import type { MissionScenario } from "@/shared/exit-check";
import { buildExitCheckReport } from "./exit-report";
import type { LlmClient } from "./llm";
import type { MissionRunBudget } from "./tools";

export interface OrchestratorDeps {
  store: Store;
  runtime: AppRuntime;
  llm: LlmClient;
  publicClient: ReadClient;
  baseUrl: string;
  paidFetch?: typeof fetch;
}

export interface MissionScenarioInput {
  missionId: string;
  task: string;
  addresses: Address[];
  scenario?: MissionScenario;
  positionUsd?: string;
  deps: OrchestratorDeps;
}

function sourceFromPurchase(purchase: Purchase) {
  const facts = purchase.resultJson ? JSON.parse(purchase.resultJson) as Record<string, unknown> : null;
  return {
    paymentId: purchase.paymentId,
    providerId: purchase.providerId,
    request: JSON.parse(purchase.requestJson) as Record<string, unknown>,
    blockNumber: typeof facts?.blockNumber === "number" ? facts.blockNumber : null,
    settlementBlockNumber: purchase.blockNumber,
    txHash: purchase.txHash,
    amount: purchase.amount.toString(),
    responseHash: purchase.responseHash,
  };
}

function refusalFromPurchase(purchase: Purchase) {
  return {
    providerId: purchase.providerId,
    request: JSON.parse(purchase.requestJson) as Record<string, unknown>,
    state: purchase.state,
    reason: purchase.reason,
  };
}

/**
 * Runs the demonstration scenario: Code Analyst buys code facts for two
 * addresses, Activity Analyst tries the activity facts for the first address.
 * The third paid call is expected to be refused when the shared 0.05 USDC
 * budget is already at 0.04 — the report then contains the facts that were
 * actually paid for plus the refusal reason.
 */
export async function runMissionScenario(
  input: MissionScenarioInput,
): Promise<MissionReport> {
  const { store, runtime, llm, publicClient, baseUrl } = input.deps;
  const mission = store.getMission(input.missionId);
  if (mission.status !== "active") {
    throw new Error(`mission is ${mission.status}`);
  }
  if (!runtime.executor || !runtime.config.relayerAddress) {
    throw new Error(
      "executor/relayer keys are not configured; cannot run the paid mission",
    );
  }
  if (input.addresses.length < 1) {
    throw new Error("at least one address is required");
  }
  store.appendEvent({
    missionId: mission.id,
    type: "mission.scenario.started",
    payload: { task: input.task, addresses: input.addresses },
  });

  const budget: MissionRunBudget = { paidAttempts: 0, maxPaidAttempts: 3 };
  const client = new X402AgentClient({
    store,
    mission,
    publicClient,
    executor: runtime.executor,
    environment: runtime.environment,
    chainId: runtime.config.chainId,
    relayerAddress: runtime.config.relayerAddress,
    token: runtime.config.token,
    budgetEnforcerAddress: runtime.config.budgetEnforcerAddress,
    providers: runtime.providers,
    baseUrl,
    fetchImpl: input.deps.paidFetch,
  });

  const outcomes: AgentRunOutcome[] = [];
  const runSafely = async (
    definition: typeof CODE_ANALYST,
    addresses: Address[],
  ): Promise<AgentRunOutcome> => {
    try {
      return await runAgent({
        definition,
        mission,
        task: input.task,
        addresses,
        store,
        llm,
        client,
        budget,
        positionUsd: input.scenario === "exit-check" ? (input.positionUsd ?? "100") : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendEvent({
        missionId: mission.id,
        type: "agent.failed",
        payload: { agent: definition.name, error: message },
      });
      return {
        runId: `failed-${definition.ref}`,
        agentName: definition.name,
        status: "failed",
        summary: "",
        error: message,
      };
    }
  };
  if (input.scenario === "exit-check") {
    outcomes.push(await runSafely(MARKET_ANALYST, input.addresses.slice(0, 2)));
    outcomes.push(await runSafely(EXIT_ANALYST, input.addresses.slice(0, 2)));
  } else {
    outcomes.push(await runSafely(CODE_ANALYST, input.addresses.slice(0, 2)));
    outcomes.push(await runSafely(ACTIVITY_ANALYST, input.addresses.slice(0, 1)));
  }

  const purchases = store.listPurchases(mission.id);
  const settled = purchases.filter((purchase) => purchase.state === "settled" && purchase.resultJson !== null);
  const refused = purchases.filter((purchase) => purchase.state !== "settled" || purchase.resultJson === null);
  const receiptSpent = store.computeMissionSpent(mission.id);
  let onchainSpent = receiptSpent;
  try {
    const value = await readDelegationSpent({
      publicClient,
      enforcerAddress: runtime.config.budgetEnforcerAddress,
      delegationManager: runtime.environment.DelegationManager,
      delegationHash: mission.rootDelegationHash,
    });
    if (value !== null) onchainSpent = value;
  } catch {
    // keep the locally recorded spend
  }
  const usage = store.computeLlmUsage(mission.id);

  const summaryLines = outcomes
    .map(
      (outcome) =>
        `${outcome.agentName} [${outcome.status}]: ${outcome.summary || outcome.error || "no summary"}`,
    )
    .slice(0, 4);
  const summary = [
    `Task: ${input.task}`,
    ...summaryLines,
    settled.length > 0
      ? `Paid sources: ${settled.length}; spent ${onchainSpent} of ${mission.policy.budget} minimal units.`
      : "No paid sources were settled.",
    refused.length > 0
      ? `Refusals: ${refused.map((purchase) => `${purchase.providerId} (${purchase.reason ?? purchase.state})`).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const report: MissionReport = {
    missionId: mission.id,
    task: input.task,
    addresses: input.addresses,
    createdAt: Math.floor(Date.now() / 1000),
    summary,
    ...(input.scenario === "exit-check" ? { exitCheck: buildExitCheckReport(purchases, input.addresses, input.positionUsd ?? "100") } : {}),
    agentSummaries: outcomes.map((outcome) => ({
      agentName: outcome.agentName,
      status: outcome.status,
      summary: outcome.summary,
      error: outcome.error,
    })),
    sources: settled.map(sourceFromPurchase),
    refusals: refused.map(refusalFromPurchase),
    budget: {
      budget: mission.policy.budget.toString(),
      perCallMax: mission.policy.perCallMax.toString(),
      spent: onchainSpent.toString(),
      remaining:
        mission.policy.budget > onchainSpent
          ? (mission.policy.budget - onchainSpent).toString()
          : "0",
    },
    llm: {
      calls: usage.calls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    },
  };
  store.saveReport(report);
  const current = store.getMission(mission.id);
  if (current.status === "active") {
    store.updateMissionStatus(mission.id, "completed");
  }
  return report;
}

export function missionHasReport(mission: MissionRecord, store: Store): boolean {
  return store.getReport(mission.id) !== null;
}
