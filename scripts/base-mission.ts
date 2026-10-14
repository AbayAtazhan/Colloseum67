/**
 * Runs the full live mission on Base Sepolia against a running app
 * (`npm run dev` with SWARM_TAB_NETWORK=base-sepolia and the DeepSeek key).
 *
 * The user's MetaMask key is never requested: this testnet runner uses the
 * server-side test owner key from .env to sign the mission root, then the
 * configured executor/relayer keys perform the payments.
 *
 * Usage:
 *   npm run dev             # terminal 1
 *   npm run base:mission    # terminal 2
 */
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { erc20Abi } from "viem";
import { formatAmountShort } from "@/shared/amounts";

const baseUrl = (
  process.env.SWARM_TAB_PUBLIC_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");
const explorer = "https://sepolia.basescan.org";

interface SetupState {
  mode: string;
  network: string;
  token: { address: `0x${string}`; symbol: string; decimals: number };
  demoAddresses: string[];
  budget: string;
  deepseek: { hasKey: boolean; fakeLlm: boolean; model: string };
  explorerBaseUrl: string | null;
}

interface StateResponse {
  mission: { id: string; status: string; smartAccountAddress: string } | null;
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
  llmUsage: { calls: number; fixtureCalls: number; totalTokens: number };
  report: {
    summary: string;
    sources: Array<{ providerId: string; txHash: string | null }>;
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

async function main(): Promise<void> {
  const setup = await json<SetupState>("/api/setup");
  if (setup.mode !== "base-sepolia") {
    throw new Error(
      `the app is running in '${setup.mode}' mode; start it with SWARM_TAB_NETWORK=base-sepolia`,
    );
  }
  if (setup.deepseek.fakeLlm) {
    throw new Error(
      "SWARM_TAB_FAKE_LLM=1 is set; this runner is only for a live DeepSeek run",
    );
  }
  if (!setup.deepseek.hasKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured on the server");
  }
  console.log(`App: ${setup.network}, model ${setup.deepseek.model}`);

  const ownerKey = process.env.USER_OWNER_PRIVATE_KEY;
  if (!ownerKey) {
    throw new Error(
      "USER_OWNER_PRIVATE_KEY is required for the testnet runner (it is a generated test owner, not the user's MetaMask key)",
    );
  }
  const owner = privateKeyToAccount(ownerKey as `0x${string}`);

  const task =
    "Check the code of both addresses and the activity of the first address, then summarize what the paid data proves.";
  const prepared = await json<{
    smartAccountAddress: `0x${string}`;
    typedData: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    delegation: Record<string, unknown>;
  }>("/api/missions/prepare", {
    method: "POST",
    body: JSON.stringify({
      title: "Base Sepolia DeepSeek mission",
      task,
      addresses: setup.demoAddresses,
      budgetUsdc: formatAmountShort(BigInt(setup.budget), setup.token.decimals),
      ownerAddress: owner.address,
    }),
  });

  // Pre-flight: the spending account must be able to cover the budget.
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org"),
  });
  const balance = await publicClient.readContract({
    address: setup.token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [prepared.smartAccountAddress],
  });
  console.log(
    `Spending smart account ${prepared.smartAccountAddress}: ${formatAmountShort(balance, 6)} USDC`,
  );
  if (balance < BigInt(setup.budget)) {
    throw new Error(
      `smart account has ${balance} minimal units and the budget is ${setup.budget}; fund it first (faucet.circle.com, Base Sepolia)`,
    );
  }

  const signature = await owner.signTypedData({
    domain: prepared.typedData.domain,
    types: prepared.typedData.types,
    primaryType: prepared.typedData.primaryType,
    message: prepared.typedData.message,
  } as never);

  const created = await json<{ missionId: string }>("/api/missions", {
    method: "POST",
    body: JSON.stringify({
      mode: "wallet",
      title: "Base Sepolia DeepSeek mission",
      task,
      addresses: setup.demoAddresses,
      budgetUsdc: formatAmountShort(BigInt(setup.budget), setup.token.decimals),
      ownerAddress: owner.address,
      delegation: prepared.delegation,
      signature,
    }),
  });
  console.log(`Mission: ${created.missionId}`);
  console.log(`Root permission: ${explorer}/address/${prepared.smartAccountAddress}`);

  await json(`/api/missions/${created.missionId}/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  const deadline = Date.now() + 10 * 60_000;
  let state: StateResponse | null = null;
  while (Date.now() < deadline) {
    state = await json<StateResponse>(
      `/api/state?missionId=${created.missionId}`,
    );
    if (!state.running && state.report) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!state?.report) throw new Error("mission did not produce a report in 10 minutes");

  console.log("\nAgents");
  for (const agent of state.agents) {
    console.log(`  - ${agent.agentName}: ${agent.status}`);
  }

  console.log("\nPayments");
  for (const purchase of state.purchases) {
    const tx = purchase.txHash ? `${explorer}/tx/${purchase.txHash}` : "—";
    console.log(
      `  - ${purchase.providerId} ${String(purchase.request.address ?? "")} ` +
        `${formatAmountShort(BigInt(purchase.amount), 6)} USDC -> ${purchase.state}` +
        ` block=${purchase.blockNumber ?? "—"} tx=${tx}` +
        (purchase.reason ? ` reason=${purchase.reason}` : ""),
    );
  }

  console.log("\nReport");
  console.log(state.report.summary);

  const settled = state.report.sources.length;
  const refused = state.report.refusals.length;
  const fixtureCalls = state.llmUsage.fixtureCalls;
  console.log(
    `\nLive DeepSeek calls: ${state.llmUsage.calls} (fixture: ${fixtureCalls}), tokens: ${state.llmUsage.totalTokens}`,
  );
  console.log(
    `Settled: ${settled}, refused: ${refused}; spent ${state.report.budget.spent} of ${state.report.budget.budget} minimal units`,
  );

  if (fixtureCalls > 0) {
    throw new Error("fixture LLM calls detected in a live run");
  }
  if (settled !== 2 || refused !== 1) {
    throw new Error(
      `expected exactly 2 settled + 1 refused, got ${settled} + ${refused}`,
    );
  }
  console.log("\nBase Sepolia mission complete.");
}

main().catch((error) => {
  console.error(
    "\nbase:mission failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
