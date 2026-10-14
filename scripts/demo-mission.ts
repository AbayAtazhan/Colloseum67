/**
 * CLI reproduction of the full user scenario against a running app
 * (`npm run dev:local` in another terminal):
 *
 *   task -> two DeepSeek agents -> paid HTTP via x402 -> confirmed settlements
 *   -> report with sources (and the expected third-request refusal).
 *
 * Usage: npm run demo:mission
 */
import "dotenv/config";

const baseUrl = (
  process.env.SWARM_TAB_PUBLIC_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");

interface SetupState {
  mode: string;
  network: string;
  demoAddresses: string[];
  deepseek: { hasKey: boolean; fakeLlm: boolean; model: string };
}

interface StateResponse {
  mission: { id: string; status: string } | null;
  purchases: Array<{
    providerId: string;
    state: string;
    amount: string;
    txHash: string | null;
    blockNumber: number | null;
    reason: string | null;
    request: Record<string, unknown>;
  }>;
  agents: Array<{ agentName: string; status: string; detail: string | null }>;
  llmUsage: { calls: number; totalTokens: number };
  report: {
    summary: string;
    sources: Array<{
      providerId: string;
      request: Record<string, unknown>;
      blockNumber: number | null;
      txHash: string | null;
    }>;
    refusals: Array<{ providerId: string; state: string; reason: string | null }>;
    budget: { budget: string; spent: string; remaining: string };
  } | null;
  spent: string;
  running: boolean;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed: ${body.message ?? response.status}`,
    );
  }
  return body;
}

function usdc(value: string): string {
  const base = 10n ** 6n;
  const amount = BigInt(value);
  return `${amount / base}.${(amount % base).toString().padStart(6, "0")}`;
}

async function main(): Promise<void> {
  const setup = await json<SetupState>("/api/setup");
  console.log(`App mode: ${setup.mode} (${setup.network})`);
  console.log(
    `LLM: ${setup.deepseek.fakeLlm ? "fixture (test mode)" : setup.deepseek.model}`,
  );

  const task =
    "Check the code of both addresses and the activity of the first address, then summarize what the paid data proves.";
  const created = await json<{ missionId: string }>("/api/missions", {
    method: "POST",
    body: JSON.stringify({
      mode: "local",
      title: "CLI demo mission",
      task,
      addresses: setup.demoAddresses,
      budgetUsdc: "0.05",
    }),
  });
  console.log(`Mission: ${created.missionId}`);
  await json(`/api/missions/${created.missionId}/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  const deadline = Date.now() + 180_000;
  let state: StateResponse | null = null;
  while (Date.now() < deadline) {
    state = await json<StateResponse>(
      `/api/state?missionId=${created.missionId}`,
    );
    if (!state.running && state.report) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!state?.report) {
    throw new Error("mission did not produce a report within 180s");
  }

  console.log("\nAgents:");
  for (const agent of state.agents) {
    console.log(`  - ${agent.agentName}: ${agent.status}`);
    if (agent.detail) {
      console.log(
        `    ${agent.detail.split("\n").slice(0, 3).join(" ").slice(0, 220)}`,
      );
    }
  }

  console.log("\nPurchases:");
  for (const purchase of state.purchases) {
    const hash = purchase.txHash ? `${purchase.txHash.slice(0, 18)}…` : "—";
    console.log(
      `  - ${purchase.providerId} ${String(purchase.request.address ?? "")} ${usdc(
        purchase.amount,
      )} USDC -> ${purchase.state} block=${purchase.blockNumber ?? "—"} tx=${hash}${
        purchase.reason ? ` reason=${purchase.reason}` : ""
      }`,
    );
  }

  console.log("\nReport:");
  console.log(state.report.summary.split("\n").map((line) => `  ${line}`).join("\n"));
  console.log(
    `\nBudget: spent ${usdc(state.report.budget.spent)} of ${usdc(
      state.report.budget.budget,
    )} USDC, remaining ${usdc(state.report.budget.remaining)} USDC`,
  );
  console.log(
    `DeepSeek usage: ${state.llmUsage.calls} calls, ${state.llmUsage.totalTokens} tokens`,
  );

  const settled = state.report.sources.length;
  const refused = state.report.refusals.length;
  console.log(
    `\nSources settled: ${settled}; refusals: ${refused} (expected: 2 settled, 1 refusal when the budget is 0.05).`,
  );
  if (settled !== 2 || refused !== 1) {
    throw new Error(
      `unexpected scenario outcome: settled=${settled} refused=${refused}`,
    );
  }
}

main().catch((error) => {
  console.error(
    "\ndemo:mission failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
