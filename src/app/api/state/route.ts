import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { loadAppRuntime } from "@/payments/runtime";
import { readDelegationSpent, readTokenBalance } from "@/payments/spend";
import { getDefaultStore } from "@/store";
import { isMissionRunning } from "@/agents/runner";
import type { MissionPolicy, MissionRecord } from "@/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function serializePolicy(policy: MissionPolicy) {
  return {
    chainId: policy.chainId,
    token: policy.token,
    budget: policy.budget.toString(),
    perCallMax: policy.perCallMax.toString(),
    recipients: policy.recipients,
    validAfter: policy.validAfter,
    validBefore: policy.validBefore,
    redeemer: policy.redeemer,
  };
}

function serializeMission(mission: MissionRecord) {
  return {
    id: mission.id,
    title: mission.title,
    status: mission.status,
    policy: serializePolicy(mission.policy),
    ownerAddress: mission.ownerAddress,
    smartAccountAddress: mission.smartAccountAddress,
    executorAddress: mission.executorAddress,
    rootDelegationHash: mission.rootDelegationHash,
    enforcerAddress: mission.enforcerAddress,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

/** Polling endpoint for the mission console. Public data only. */
export async function GET(request: NextRequest) {
  try {
    const app = loadAppRuntime();
    const store = getDefaultStore();
    const missionId = new URL(request.url).searchParams.get("missionId");
    const mission = missionId
      ? store.findMission(missionId)
      : (store.listMissions()[0] ?? null);

    if (!mission) {
      return NextResponse.json({
        mission: null,
        missions: [],
        purchases: [],
        attempts: [],
        agents: [],
        llmCalls: [],
        llmUsage: { calls: 0, fixtureCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        report: null,
        spent: "0",
        remaining: "0",
        onchainSpent: null,
        smartAccountBalance: "0",
        revokeTxHash: null,
        events: [],
        running: false,
      });
    }

    const policy = mission.policy;
    const localSpent = store.computeMissionSpent(mission.id);
    let onchainSpent: bigint | null = null;
    try {
      onchainSpent = await readDelegationSpent({
        publicClient: app.publicClient,
        enforcerAddress: app.config.budgetEnforcerAddress,
        delegationManager: app.environment.DelegationManager,
        delegationHash: mission.rootDelegationHash,
      });
    } catch {
      onchainSpent = null;
    }
    const spent = onchainSpent ?? localSpent;
    const remaining = policy.budget > spent ? policy.budget - spent : 0n;
    const smartAccountBalance = await readTokenBalance({
      publicClient: app.publicClient,
      token: app.config.token.address,
      account: mission.smartAccountAddress,
    }).catch(() => 0n);
    const events = store
      .listEvents(mission.id)
      .slice(-80)
      .map((event) => ({
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      }));
    const revokeTxHash = [...events]
      .reverse()
      .find((event) => event.type === "mission.revoke.confirmed")?.payload
      ?.txHash as string | undefined;

    return NextResponse.json({
      mission: serializeMission(mission),
      missions: store.listMissions().map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        createdAt: item.createdAt,
      })),
      purchases: store.listPurchases(mission.id).map((purchase) => ({
        id: purchase.id,
        paymentId: purchase.paymentId,
        providerId: purchase.providerId,
        requestHash: purchase.requestHash,
        responseHash: purchase.responseHash,
        amount: purchase.amount.toString(),
        payTo: purchase.payTo,
        state: purchase.state,
        errorKind: purchase.errorKind,
        reason: purchase.reason,
        txHash: purchase.txHash,
        blockNumber: purchase.blockNumber,
        spentAfter: purchase.spentAfter?.toString() ?? null,
        payer: purchase.payer,
        request: JSON.parse(purchase.requestJson) as Record<string, unknown>,
        result: purchase.resultJson
          ? (JSON.parse(purchase.resultJson) as Record<string, unknown>)
          : null,
        createdAt: purchase.createdAt,
        updatedAt: purchase.updatedAt,
      })),
      attempts: store.listPaymentAttempts(mission.id).map((attempt) => ({
        id: attempt.id,
        agentRunId: attempt.agentRunId,
        recipient: attempt.recipient,
        amount: attempt.amount.toString(),
        state: attempt.state,
        delegationHash: attempt.delegationHash,
        txHash: attempt.txHash,
        errorKind: attempt.errorKind,
        reason: attempt.reason,
        createdAt: attempt.createdAt,
      })),
      agents: store.listAgentRuns(mission.id).map((run) => ({
        id: run.id,
        agentName: run.agentName,
        agentRef: run.agentRef,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        detail: run.detail,
      })),
      llmCalls: store.listLlmCalls(mission.id).map((call) => ({
        id: call.id,
        agentName: call.agentName,
        callIndex: call.callIndex,
        model: call.model,
        fixture: call.fixture,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        totalTokens: call.totalTokens,
        state: call.state,
        error: call.error,
        createdAt: call.createdAt,
      })),
      llmUsage: store.computeLlmUsage(mission.id),
      report: store.getReport(mission.id),
      spent: spent.toString(),
      remaining: remaining.toString(),
      onchainSpent: onchainSpent?.toString() ?? null,
      smartAccountBalance: smartAccountBalance.toString(),
      revokeTxHash: revokeTxHash ?? null,
      events,
      running: isMissionRunning(mission.id),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "state_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
