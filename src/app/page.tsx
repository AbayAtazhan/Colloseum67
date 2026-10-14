"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { EXIT_DEMO_ADDRESSES, EXIT_DEMO_TASK, type ExitCheckReport, type MissionScenario } from "@/shared/exit-check";
import { ExitCheck } from "./components/exit-check";

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

interface SetupState {
  hostedDemo?: boolean;
  mode: "local" | "base-sepolia";
  network: string;
  chainId: number;
  rpcUrl: string;
  token: { address: string; symbol: string; decimals: number };
  budget: string;
  perCallMax: string;
  recipients: string[];
  executorAddress: string | null;
  relayerAddress: string | null;
  ownerAddress: string | null;
  enforcerAddress: string | null;
  providerPayTo: Record<string, string>;
  explorerBaseUrl: string | null;
  deepseek: { hasKey: boolean; fakeLlm: boolean; model: string };
  local: null | {
    chainId: number;
    rpcUrl: string;
    tokenAddress: string;
    smartAccountAddress: string;
  };
  demoAddresses: string[];
  exitDemo: { addresses: string[]; task: string; analysisChainId: number; positionUsd: string };
  revokeAvailable: boolean;
  providers: Array<{
    id: string;
    name: string;
    description: string;
    path: string;
    price: string;
    payTo: string;
  }>;
}

interface PurchaseState {
  id: string;
  paymentId: string;
  providerId: string;
  requestHash: string;
  responseHash: string | null;
  amount: string;
  payTo: string;
  state: "pending" | "settled" | "rejected" | "failed";
  errorKind: string | null;
  reason: string | null;
  txHash: string | null;
  blockNumber: number | null;
  spentAfter: string | null;
  payer: string | null;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: number;
}

interface StateEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

interface MissionState {
  mission: null | {
    id: string;
    title: string;
    status: string;
    policy: {
      budget: string;
      perCallMax: string;
      recipients: string[];
      validBefore: number;
    };
    ownerAddress: string;
    smartAccountAddress: string;
    rootDelegationHash: string;
    createdAt: number;
  };
  purchases: PurchaseState[];
  attempts: Array<{
    id: string;
    recipient: string;
    amount: string;
    state: string;
    txHash: string | null;
    reason: string | null;
    createdAt: number;
  }>;
  agents: Array<{
    id: string;
    agentName: string;
    status: string;
    detail: string | null;
    startedAt: number;
    endedAt: number | null;
  }>;
  llmCalls: Array<{
    id: string;
    agentName: string;
    callIndex: number;
    model: string;
    fixture: boolean;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    state: string;
    error: string | null;
  }>;
  llmUsage: {
    calls: number;
    fixtureCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  report: null | {
    summary: string;
    exitCheck?: ExitCheckReport;
    sources: Array<{
      paymentId?: string;
      providerId: string;
      request: Record<string, unknown>;
      blockNumber: number | null;
      settlementBlockNumber?: number | null;
      txHash: string | null;
      amount: string;
      responseHash: string | null;
    }>;
    refusals: Array<{
      providerId: string;
      request: Record<string, unknown>;
      state: string;
      reason: string | null;
    }>;
    budget: { budget: string; perCallMax: string; spent: string; remaining: string };
    llm: {
      calls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  };
  spent: string;
  remaining: string;
  onchainSpent: string | null;
  smartAccountBalance: string;
  revokeTxHash: string | null;
  events: StateEvent[];
  running: boolean;
}

interface StressResult {
  missionId: string;
  requests: number;
  settled: number;
  rejected: number;
  failed: number;
  onchainSpent: string;
  budget: string;
  results: Array<{
    providerId: string;
    state: "settled" | "rejected" | "failed";
    txHash: string | null;
    reason: string | null;
  }>;
}

const DEFAULT_TASK =
  "Check the code of both addresses and the activity of the first address, then summarize what the paid data proves.";

function usdc(value: string | null | undefined, decimals = 6): string {
  if (value === null || value === undefined) return "—";
  try {
    return `${formatUnits(BigInt(value), decimals)} USDC`;
  } catch {
    return "—";
  }
}

function short(value: string | null | undefined, size = 8): string {
  if (!value) return "—";
  return `${value.slice(0, size + 2)}…${value.slice(-size)}`;
}

function stateColor(state: string): string {
  if (state === "settled" || state === "completed" || state === "ok" || state === "revoked") {
    return "bg-emerald-950 text-emerald-300 border-emerald-800";
  }
  if (state === "rejected" || state === "failed" || state === "no_balance" || state === "error") {
    return "bg-rose-950 text-rose-300 border-rose-900";
  }
  if (
    state === "running" ||
    state === "pending" ||
    state === "submitted" ||
    state === "active" ||
    state === "signing" ||
    state === "confirming"
  ) {
    return "bg-amber-950 text-amber-300 border-amber-900";
  }
  return "bg-zinc-900 text-zinc-300 border-zinc-700";
}

function readableReason(reason: string): string {
  if (reason.includes("insufficient_funds")) return "Shared budget limit reached";
  if (reason.includes("invalid_transaction_state")) return "Permission cannot be used";
  return reason;
}

function agentStage(agent: MissionState["agents"][number], events: StateEvent[]): string {
  if (agent.status === "completed") return "completed";
  if (agent.status === "failed") return "service error";
  const latest = [...events]
    .reverse()
    .find((event) => event.payload.agentRunId === agent.id);
  if (!latest) return "starting…";
  switch (latest.type) {
    case "agent.llm_call":
      return `thinking… (LLM #${latest.payload.callIndex ?? "?"})`;
    case "agent.tool_call":
      return `requesting data · ${String(latest.payload.tool ?? "")}${
        latest.payload.paidCall ? ` · paid call ${latest.payload.paidCall}/${latest.payload.paidCallLimit}` : ""
      }`;
    case "agent.tool_result":
      return latest.payload.ok
        ? `data received · ${String(latest.payload.providerId ?? "")}`
        : `refused · ${readableReason(String(latest.payload.reason ?? latest.payload.state ?? ""))}`;
    case "agent.limit":
      return "limit reached";
    case "agent.failed":
      return "service error";
    default:
      return "working…";
  }
}

export default function Home() {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [state, setState] = useState<MissionState | null>(null);
  const [stress, setStress] = useState<StressResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scenario, setScenario] = useState<MissionScenario>("exit-check");
  const [positionUsd, setPositionUsd] = useState("100");
  const [task, setTask] = useState(EXIT_DEMO_TASK);
  const [address1, setAddress1] = useState<string>(EXIT_DEMO_ADDRESSES[0]);
  const [address2, setAddress2] = useState<string>(EXIT_DEMO_ADDRESSES[1]);
  const [budget, setBudget] = useState("0.05");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [revokeStage, setRevokeStage] = useState<
    "idle" | "signing" | "submitting" | "confirming" | "error"
  >("idle");
  const missionIdRef = useRef<string | null>(null);

  const loadSetup = useCallback(async () => {
    try {
      const response = await fetch("/api/setup", { cache: "no-store" });
      const body = (await response.json()) as SetupState & { message?: string };
      if (!response.ok) {
        setError(body.message ?? "Setup unavailable");
        return;
      }
      setSetup(body);
      setBudget(formatUnits(BigInt(body.budget), body.token.decimals));
      setAddress1((current) => current || (body.demoAddresses[0] ?? ""));
      setAddress2((current) => current || (body.demoAddresses[1] ?? ""));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const loadState = useCallback(async () => {
    try {
      const query = missionIdRef.current
        ? `?missionId=${encodeURIComponent(missionIdRef.current)}`
        : "";
      const selectedMission = missionIdRef.current;
      const response = await fetch(`/api/state${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || missionIdRef.current !== selectedMission) return;
      setState(body as MissionState);
      if (!missionIdRef.current && (body as MissionState).mission) {
        missionIdRef.current = (body as MissionState).mission?.id ?? null;
      }
    } catch {
      // keep the last good state; the next poll retries
    }
  }, []);

  useEffect(() => {
    // Initial public setup read; async state lands after the effect returns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSetup();
  }, [loadSetup]);

  useEffect(() => {
    void loadState();
    const timer = setInterval(() => void loadState(), 2000);
    return () => clearInterval(timer);
  }, [loadState]);

  useEffect(() => {
    const ethereum = window.ethereum;
    const accountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setWalletAddress(accounts?.[0] ?? null);
    };
    const chainChanged = () => setWalletAddress(null);
    ethereum?.on?.("accountsChanged", accountsChanged);
    ethereum?.on?.("chainChanged", chainChanged);
    return () => {
      ethereum?.removeListener?.("accountsChanged", accountsChanged);
      ethereum?.removeListener?.("chainChanged", chainChanged);
    };
  }, []);

  const post = useCallback(
    async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          (payload as { message?: string; error?: string }).message ??
            (payload as { error?: string }).error ??
            `request failed (${response.status})`,
        );
      }
      return payload;
    },
    [],
  );

  const addresses = [address1, address2].filter(Boolean);

  const loadDemo = useCallback(() => {
    if (!setup) return;
    const tokens = scenario === "exit-check" ? setup.exitDemo.addresses : setup.demoAddresses;
    setTask(scenario === "exit-check" ? EXIT_DEMO_TASK : DEFAULT_TASK);
    setAddress1(tokens[0] ?? "");
    setAddress2(tokens[1] ?? "");
    setPositionUsd("100");
    setBudget(formatUnits(BigInt(setup.budget), setup.token.decimals));
    setError(null);
  }, [setup, scenario]);

  const createLocalMission = useCallback(async () => {
    setBusy("local-mission");
    setError(null);
    try {
      const created = (await post("/api/missions", {
        mode: "local",
        title: scenario === "exit-check" ? "Token exit check" : "DeepSeek agent mission",
        task,
        addresses,
        scenario, positionUsd,
        budgetUsdc: budget,
      })) as { missionId: string };
      missionIdRef.current = created.missionId;
      setStress(null);
      await post(`/api/missions/${created.missionId}/start`, {});
      await loadState();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(null);
    }
  }, [addresses, budget, loadState, post, task, scenario, positionUsd]);

  const connectWallet = useCallback(async () => {
    setError(null);
    try {
      const ethereum = window.ethereum;
      if (!ethereum) {
        throw new Error(
          "MetaMask was not found in this browser. Use the server-signed testnet demo below, or install MetaMask.",
        );
      }
      const accounts = (await ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (setup) {
        const chainHex = `0x${setup.chainId.toString(16)}`;
        try {
          await ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: chainHex }],
          });
        } catch (switchError) {
          if ((switchError as { code?: number }).code !== 4902) throw switchError;
          await ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: chainHex,
                chainName: setup.hostedDemo ? "SWARM TAB Hosted demo" : setup.mode === "local" ? "SWARM TAB Local testnet" : "Base Sepolia",
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: [setup.rpcUrl],
              },
            ],
          });
          await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
        }
      }
      const currentAccounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
      setWalletAddress(currentAccounts[0] ?? accounts[0] ?? null);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : String(connectError));
    }
  }, [setup]);

  const signWalletPermission = useCallback(async () => {
    if (!walletAddress) {
      setError("Connect the wallet that owns the smart account first.");
      return;
    }
    setBusy("wallet-mission");
    setError(null);
    try {
      const prepared = (await post("/api/missions/prepare", {
        title: scenario === "exit-check" ? "Token exit check" : "DeepSeek agent mission",
        task,
        addresses,
        scenario, positionUsd,
        budgetUsdc: budget,
        ownerAddress: walletAddress,
      })) as {
        delegation: Record<string, unknown>;
        typedData: Record<string, unknown>;
      };
      const ethereum = window.ethereum;
      if (!ethereum) throw new Error("MetaMask was not found in this browser");
      const signature = (await ethereum.request({
        method: "eth_signTypedData_v4",
        params: [walletAddress, JSON.stringify(prepared.typedData)],
      })) as string;
      const created = (await post("/api/missions", {
        mode: "wallet",
        title: scenario === "exit-check" ? "Token exit check" : "DeepSeek agent mission",
        task,
        addresses,
        scenario, positionUsd,
        budgetUsdc: budget,
        ownerAddress: walletAddress,
        delegation: prepared.delegation,
        signature,
      })) as { missionId: string };
      missionIdRef.current = created.missionId;
      setStress(null);
      await loadState();
      await post(`/api/missions/${created.missionId}/start`, {});
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : String(signError));
    } finally {
      setBusy(null);
    }
  }, [addresses, budget, loadState, post, task, walletAddress, scenario, positionUsd]);

  const startMission = useCallback(async () => {
    if (!missionIdRef.current) return;
    setBusy("start");
    setError(null);
    try {
      await post(`/api/missions/${missionIdRef.current}/start`, {});
      await loadState();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(null);
    }
  }, [loadState, post]);

  const revokeMission = useCallback(async () => {
    if (!missionIdRef.current || !state?.mission) return;
    setBusy("revoke");
    setError(null);
    setRevokeStage("submitting");
    try {
      const prepared = (await post(
        `/api/missions/${missionIdRef.current}/revoke/prepare`,
        {},
      )) as {
        ownerAddress: string;
        userOp: { typedData: Record<string, unknown> };
      };
      const connectedOwns =
        walletAddress &&
        prepared.ownerAddress.toLowerCase() === walletAddress.toLowerCase();
      let txHash: string;
      if (connectedOwns) {
        const ethereum = window.ethereum;
        if (!ethereum) throw new Error("MetaMask was not found in this browser");
        setRevokeStage("signing");
        const signature = (await ethereum.request({
          method: "eth_signTypedData_v4",
          params: [walletAddress, JSON.stringify(prepared.userOp.typedData)],
        })) as string;
        setRevokeStage("confirming");
        const result = (await post(`/api/missions/${missionIdRef.current}/revoke`, {
          userOp: prepared.userOp,
          signature,
        })) as { txHash: string };
        txHash = result.txHash;
      } else if (setup?.mode === "local" && setup.revokeAvailable &&
                 setup.ownerAddress?.toLowerCase() === prepared.ownerAddress.toLowerCase()) {
        setRevokeStage("confirming");
        const result = (await post(`/api/missions/${missionIdRef.current}/revoke`, {})) as {
          txHash: string;
        };
        txHash = result.txHash;
      } else {
        throw new Error(
          `Connect ${prepared.ownerAddress} in MetaMask to sign the revocation.`,
        );
      }
      void txHash;
      setRevokeStage("idle");
      await loadState();
    } catch (revokeError) {
      setRevokeStage("error");
      setError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    } finally {
      setBusy(null);
    }
  }, [loadState, post, setup, state?.mission, walletAddress]);

  const runStressTest = useCallback(async () => {
    setBusy("stress");
    setError(null);
    setStress(null);
    try {
      const result = (await post("/api/missions/stress", {
        address: setup?.demoAddresses[0] ?? address1,
        count: 3,
      })) as StressResult;
      setStress(result);
      missionIdRef.current = result.missionId;
      await loadState();
    } catch (stressError) {
      setError(stressError instanceof Error ? stressError.message : String(stressError));
    } finally {
      setBusy(null);
    }
  }, [address1, loadState, post, setup]);

  const mission = state?.mission ?? null;
  const spent = state?.spent ?? "0";
  const budgetValue = mission ? BigInt(mission.policy.budget) : 0n;
  const spentValue = BigInt(spent);
  const spentPercent =
    budgetValue > 0n ? Number((spentValue * 100n) / budgetValue) : 0;
  const smartAccountBalance = state?.smartAccountBalance;
  const walletOwnsMission =
    walletAddress &&
    mission &&
    walletAddress.toLowerCase() === mission.ownerAddress.toLowerCase();

  const txCell = (purchase: PurchaseState) => {
    if (!purchase.txHash) {
      return <span className="text-rose-300" title={purchase.reason ?? undefined}>{readableReason(purchase.reason ?? "—")}</span>;
    }
    if (setup?.explorerBaseUrl) {
      return (
        <a
          className="text-sky-400 underline decoration-dotted"
          href={`${setup.explorerBaseUrl}/tx/${purchase.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          {short(purchase.txHash)}
        </a>
      );
    }
    return (
      <details>
        <summary className="cursor-pointer text-emerald-300">
          {setup?.hostedDemo ? "demo chain receipt" : "local receipt"} · {short(purchase.txHash, 6)}
        </summary>
        <dl className="mt-1 space-y-0.5 font-mono text-[11px] text-zinc-500">
          <div>tx: {purchase.txHash}</div>
          <div>block: {purchase.blockNumber}</div>
          <div>paymentId: {purchase.paymentId}</div>
          <div>provider: {purchase.providerId}</div>
          <div>amount: {usdc(purchase.amount, setup?.token.decimals)}</div>
          <div>payer: {purchase.payer ?? "—"}</div>
          <div>requestHash: {purchase.requestHash}</div>
          <div>responseHash: {purchase.responseHash ?? "—"}</div>
          {purchase.result && <details className="mt-2"><summary className="cursor-pointer">Paid provider facts</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(purchase.result, null, 2)}</pre></details>}
          <div>spentAfter: {purchase.spentAfter ? usdc(purchase.spentAfter, setup?.token.decimals) : "—"}</div>
          {purchase.reason ? <div>reason: {purchase.reason}</div> : null}
        </dl>
      </details>
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-3 border-b border-zinc-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            SWARM TAB
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Check your exit. AI agents research within your onchain budget.
          </p>
          <p className="mt-2 font-mono text-xs text-zinc-500">
            {setup
              ? setup.mode === "local"
                ? `${setup.hostedDemo ? "Hosted demo testnet" : "Local testnet"} · chain ${setup.chainId} · ${setup.rpcUrl}`
                : `Base Sepolia · chain ${setup.chainId} · ${setup.rpcUrl}`
              : "loading network…"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1">
            {setup?.mode === "base-sepolia"
              ? "Base Sepolia · Test USDC"
              : `${setup?.hostedDemo ? "Hosted demo testnet" : "Local testnet"} · Test USDC`}
          </span>
          {setup?.deepseek.fakeLlm && (
            <span className="rounded-full border border-amber-800 bg-amber-950 px-3 py-1 text-amber-300">
              Fixture LLM (test mode)
            </span>
          )}
          {setup && !setup.deepseek.fakeLlm && setup.deepseek.hasKey && (
            <span className="rounded-full border border-emerald-900 bg-emerald-950/60 px-3 py-1 text-emerald-300">
              DeepSeek live · {setup.deepseek.model}
            </span>
          )}
          {setup && !setup.deepseek.fakeLlm && !setup.deepseek.hasKey && (
            <span className="rounded-full border border-rose-800 bg-rose-950 px-3 py-1 text-rose-300">
              DeepSeek key missing
            </span>
          )}
        </div>
      </header>

      {setup?.hostedDemo && (
        <p className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 text-xs text-amber-200">
          Hosted hackathon demo: payments use test tokens. Sessions and receipts reset when the free server restarts; an idle server may take about a minute to wake up.
        </p>
      )}

      {error && (
        <div className="rounded-lg border border-rose-900 bg-rose-950/60 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <section className="grid gap-4 lg:grid-cols-[2fr,1fr]">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">Mission setup</h2>
            <button
              className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs hover:border-zinc-400"
              onClick={loadDemo}
            >
              {scenario === "exit-check" ? "Load exit demo" : "Load contract demo"}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            {scenario === "exit-check" ? "Compare two Base tokens: current liquidity, sell routes and quoted USDC proceeds for your position size." : "Collect contract facts for two addresses."}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-zinc-400">Scenario
              <select className="mt-1 block rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm"
                value={scenario} disabled={busy !== null || state?.running}
                onChange={(event) => {
                  const selected = event.target.value as MissionScenario;
                  setScenario(selected);
                  const tokens = selected === "exit-check" ? EXIT_DEMO_ADDRESSES : setup?.demoAddresses ?? [];
                  setAddress1(tokens[0] ?? ""); setAddress2(tokens[1] ?? "");
                  setTask(selected === "exit-check" ? EXIT_DEMO_TASK : DEFAULT_TASK);
                }}>
                <option value="exit-check">Token exit check · Base</option>
                <option value="research">Contract facts · test network</option>
              </select>
            </label>
            {scenario === "exit-check" && <label className="text-xs text-zinc-400">Position value per token (USD)
              <input className="mt-1 block w-36 rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm"
                inputMode="decimal" value={positionUsd} onChange={(event) => setPositionUsd(event.target.value)} />
            </label>}
          </div>
          {scenario === "exit-check" && <p className="mt-2 text-xs text-sky-300">Read-only Base mainnet analysis · payments in {setup?.mode === "base-sepolia" ? "Base Sepolia" : setup?.hostedDemo ? "Hosted demo testnet" : "Local testnet"} Test USDC · each service costs 0.02</p>}
          <label className="mt-4 block text-xs uppercase tracking-wide text-zinc-500">
            Task
          </label>
          <textarea
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-sm outline-none focus:border-zinc-500"
            rows={3}
            value={task}
            onChange={(event) => setTask(event.target.value)}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">
                {scenario === "exit-check" ? "Base token A (demo: WETH)" : "Address 1 (code + activity)"}
              </label>
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs outline-none focus:border-zinc-500"
                value={address1}
                onChange={(event) => setAddress1(event.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">
                {scenario === "exit-check" ? "Base token B (demo: DEGEN)" : "Address 2 (code only)"}
              </label>
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs outline-none focus:border-zinc-500"
                value={address2}
                onChange={(event) => setAddress2(event.target.value)}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">
                Shared budget (USDC)
              </label>
              <input
                className="mt-1 w-32 rounded-lg border border-zinc-700 bg-zinc-950 p-2 font-mono text-sm outline-none focus:border-zinc-500"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </div>
            <button
              className="rounded-lg border border-zinc-600 px-4 py-2 text-sm hover:border-zinc-400"
              onClick={() => void connectWallet()}
            >
              {walletAddress ? `Wallet ${short(walletAddress)}` : "Connect MetaMask"}
            </button>
            <button
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={busy !== null || state?.running || addresses.length === 0 || !walletAddress}
              onClick={() => void signWalletPermission()}
            >
              {busy === "wallet-mission" ? "Signing…" : "Sign permission"}
            </button>
            {setup?.mode === "local" && (
              <button
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-400 disabled:opacity-50"
                disabled={busy !== null || state?.running || addresses.length === 0}
                onClick={() => void createLocalMission()}
                title="Server-signed testnet owner; no MetaMask signature needed"
              >
                {busy === "local-mission"
                  ? "Starting…"
                  : "Start server-signed demo"}
              </button>
            )}
          </div>
          {setup?.mode === "local" && (
            <p className="mt-3 text-xs text-amber-300/80">
              {setup.hostedDemo ? "Hosted demo testnet" : "Local testnet"}: the primary path is MetaMask on chain {setup.chainId}{" "}
              (add network RPC {setup.rpcUrl}). The server-signed button is a
              testnet fallback that signs with a well-known Hardhat owner key.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-lg font-medium">Mission status</h2>
          {mission ? (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className={`rounded border px-2 py-0.5 text-xs ${stateColor(mission.status)}`}>
                  {mission.status}
                </span>
                <span className="font-mono text-xs text-zinc-400">
                  {short(mission.rootDelegationHash, 6)}
                </span>
              </div>
              <div>
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>spent {usdc(spent, setup?.token.decimals)}</span>
                  <span>remaining {usdc(state?.remaining, setup?.token.decimals)}</span>
                </div>
                <div className="mt-1 h-2 rounded bg-zinc-800">
                  <div
                    className="h-2 rounded bg-emerald-500 transition-all"
                    style={{ width: `${Math.min(spentPercent, 100)}%` }}
                  />
                </div>
              </div>
              {state?.purchases.some((purchase) => purchase.state === "rejected" && purchase.reason?.includes("insufficient_funds")) && (
                <p className="rounded-lg border border-amber-800 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                  Contract blocked the next purchase: {usdc(mission.policy.perCallMax, setup?.token.decimals)} per call exceeds the {usdc(state.remaining, setup?.token.decimals)} mission allowance left.
                </p>
              )}
              <dl className="space-y-1 text-xs text-zinc-400">
                <div className="flex justify-between gap-2">
                  <dt>Spending account</dt>
                  <dd className="font-mono">{short(mission.smartAccountAddress, 6)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Account balance</dt>
                  <dd
                    className={
                      smartAccountBalance &&
                      BigInt(smartAccountBalance) > budgetValue
                        ? "text-emerald-300"
                        : "text-amber-300"
                    }
                  >
                    {usdc(smartAccountBalance, setup?.token.decimals)} (budget{" "}
                    {usdc(mission.policy.budget, setup?.token.decimals)})
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Per paid call</dt>
                  <dd>{usdc(mission.policy.perCallMax, setup?.token.decimals)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>DeepSeek spend</dt>
                  <dd>
                    {state?.llmUsage.calls ?? 0} calls ·{" "}
                    {state?.llmUsage.totalTokens ?? 0} tokens
                    {state?.llmUsage.fixtureCalls ? " · fixture" : ""}
                  </dd>
                </div>
                {state?.revokeTxHash && (
                  <div className="flex justify-between gap-2">
                    <dt>Revoke tx</dt>
                    <dd className="font-mono text-rose-300">
                      {short(state.revokeTxHash, 6)}
                    </dd>
                  </div>
                )}
              </dl>
              <div className="mt-auto flex flex-wrap gap-2">
                <button
                  className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs hover:border-zinc-400 disabled:opacity-50"
                  disabled={busy !== null || mission.status !== "active" || state?.running}
                  onClick={() => void startMission()}
                >
                  {state?.running ? "Agents running…" : "Start mission"}
                </button>
                <button
                  className="rounded-lg border border-rose-900 px-3 py-1.5 text-xs text-rose-300 hover:border-rose-700 disabled:opacity-50"
                  disabled={busy !== null || mission.status === "revoked"}
                  title={
                    walletOwnsMission
                      ? "Sign the revocation with MetaMask"
                        : setup?.mode === "local" && setup.revokeAvailable &&
                          setup.ownerAddress?.toLowerCase() === mission.ownerAddress.toLowerCase()
                        ? "Sign with the server-side testnet owner"
                        : `Connect ${mission.ownerAddress} in MetaMask to revoke`
                  }
                  onClick={() => void revokeMission()}
                >
                  {revokeStage === "signing"
                    ? "Waiting for wallet signature…"
                    : revokeStage === "submitting"
                      ? "Preparing revocation…"
                      : revokeStage === "confirming"
                        ? "Confirming on-chain…"
                        : "Revoke permission"}
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-zinc-500">
              No mission yet. Load the demo, then sign the permission (MetaMask)
              or start the server-signed testnet demo.
            </p>
          )}
        </div>
      </section>

      {state?.agents && state.agents.length > 0 && (
        <section className="grid gap-4 sm:grid-cols-2">
          {state.agents.map((agent) => {
            const calls = state.llmCalls.filter(
              (call) => call.agentName === agent.agentName,
            );
            const tokens = calls.reduce(
              (sum, call) => sum + (call.totalTokens ?? 0),
              0,
            );
            return (
              <article
                key={agent.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{agent.agentName}</h3>
                  <span className={`rounded border px-2 py-0.5 text-xs ${stateColor(agent.status)}`}>
                    {agent.status}
                  </span>
                </div>
                <p className="mt-2 text-xs text-zinc-400">
                  {agentStage(agent, state.events)}
                </p>
                <p className="mt-2 text-xs text-zinc-500">
                  {calls.length} model calls · {tokens} tokens
                  {calls.some((call) => call.fixture) ? " · fixture" : ""}
                </p>
                <details className="mt-3 text-xs text-zinc-300">
                  <summary className="cursor-pointer text-zinc-400">Agent summary</summary>
                  <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{agent.detail ?? "waiting…"}</p>
                </details>
                {calls.some((call) => call.error) && (
                  <p className="mt-2 text-xs text-rose-300">
                    {calls.find((call) => call.error)?.error}
                  </p>
                )}
              </article>
            );
          })}
        </section>
      )}

      {state?.report?.exitCheck && <ExitCheck report={state.report.exitCheck} />}

      {state?.purchases && state.purchases.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-lg font-medium">Purchase journal</h2>
          <p className="mt-1 text-xs text-zinc-400">
            Every paid HTTP request through x402. The on-chain contract is the
            source of truth for the shared spend; open a test-chain receipt for the
            full evidence.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2">Provider</th>
                  <th>Request</th>
                  <th>Amount</th>
                  <th>State</th>
                  <th>Block</th>
                  <th>Receipt / reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {state.purchases.map((purchase) => (
                  <tr key={purchase.id} className="align-top">
                    <td className="py-2 font-medium capitalize">{purchase.providerId}</td>
                    <td className="font-mono text-xs text-zinc-400">
                      {short(String(purchase.request.address ?? ""), 6)}
                    </td>
                    <td className="font-mono text-xs">
                      {usdc(purchase.amount, setup?.token.decimals)}
                    </td>
                    <td>
                      <span className={`rounded border px-2 py-0.5 text-xs ${stateColor(purchase.state)}`}>
                        {purchase.state}
                      </span>
                    </td>
                    <td className="font-mono text-xs">{purchase.blockNumber ?? "—"}</td>
                    <td className="text-xs">{txCell(purchase)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {state?.report && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-lg font-medium">Report</h2>
          <p className="mt-2 text-sm text-zinc-300">{state.report.sources.length} paid sources · {state.report.refusals.length} refusals · {usdc(state.report.budget.spent, setup?.token.decimals)} spent</p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-zinc-400">Full agent report</summary>
            <pre className="mt-3 whitespace-pre-wrap text-sm text-zinc-200">{state.report.summary}</pre>
          </details>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                Sources (settled payments)
              </h3>
              <ul className="mt-2 space-y-2 text-xs">
                {(state.report.sources ?? []).map((source, index) => (
                  <li
                    key={`${source.providerId}-${index}`}
                    className="rounded border border-zinc-800 p-2"
                  >
                    <span className="capitalize">{source.providerId}</span> ·{" "}
                    <span className="font-mono">
                      {short(String(source.request.address ?? ""), 6)}
                    </span>{" "}
                    · {usdc(source.amount, setup?.token.decimals)} ·{" "}
                    {source.blockNumber !== null ? `data block ${source.blockNumber}` : "dated mainnet snapshot"} ·{" "}
                    {source.txHash ? short(source.txHash, 6) : "no tx"}
                    {source.paymentId && <div className="mt-1 break-all font-mono text-[10px] text-zinc-400">paymentId {source.paymentId}</div>}
                    {source.settlementBlockNumber != null && <div className="mt-1 text-zinc-500">Payment confirmed in block {source.settlementBlockNumber}</div>}
                    {source.responseHash ? (
                      <div className="mt-1 font-mono text-[10px] text-zinc-500">
                        responseHash {short(source.responseHash, 10)}
                      </div>
                    ) : null}
                  </li>
                ))}
                {(state.report.sources ?? []).length === 0 && (
                  <li className="text-zinc-500">No paid sources settled.</li>
                )}
              </ul>
            </div>
            <div>
              <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                Refusals
              </h3>
              <ul className="mt-2 space-y-2 text-xs">
                {(state.report.refusals ?? []).map((refusal, index) => (
                  <li
                    key={`${refusal.providerId}-${index}`}
                    className="rounded border border-rose-950 bg-rose-950/30 p-2 text-rose-200"
                  >
                    <span className="capitalize">{refusal.providerId}</span> ·{" "}
                    {refusal.state} · {readableReason(refusal.reason ?? "refused")}
                  </li>
                ))}
                {(state.report.refusals ?? []).length === 0 && (
                  <li className="text-zinc-500">No refusals.</li>
                )}
              </ul>
            </div>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            DeepSeek usage (separate from the USDC budget):{" "}
            {state.report.llm.calls} calls, {state.report.llm.totalTokens} tokens.
          </p>
        </section>
      )}

      <section className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/30 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">
              Contract budget test (no LLM)
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Creates a fresh testnet mission and fires three concurrent 0.02 USDC
              x402 purchases against a 0.05 USDC budget. The contract, not the
              server, must reject the third one.
            </p>
          </div>
          <button
            className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs hover:border-zinc-400 disabled:opacity-50"
            disabled={busy !== null || Boolean(state?.running) || !setup || setup.mode !== "local"}
            onClick={() => void runStressTest()}
          >
            {busy === "stress" ? "Running…" : "Run budget test"}
          </button>
        </div>
        {stress && (
          <div className="mt-4 text-xs">
            <p>
              requests {stress.requests} · settled {stress.settled} · rejected{" "}
              {stress.rejected} · failed {stress.failed} · on-chain spent{" "}
              {usdc(stress.onchainSpent, setup?.token.decimals)} of{" "}
              {usdc(stress.budget, setup?.token.decimals)}
            </p>
            <ul className="mt-2 space-y-1">
              {stress.results.map((result, index) => (
                <li key={index} className="flex flex-wrap gap-2">
                  <span className={`rounded border px-2 py-0.5 ${stateColor(result.state)}`}>
                    {result.state}
                  </span>
                  {result.txHash ? (
                    <span className="font-mono text-zinc-400">
                      {short(result.txHash, 8)}
                    </span>
                  ) : (
                    <span className="text-rose-300">{result.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <footer className="mt-auto border-t border-zinc-800 pt-4 text-xs text-zinc-500">
        {setup?.mode === "local"
          ? `${setup.hostedDemo ? "Hosted demo testnet" : "Local testnet"} (Hardhat) · chain ${setup.chainId} · same ERC-7710 contracts and x402 path as Base Sepolia.`
          : "Base Sepolia · Test USDC. DeepSeek usage is tracked separately from the on-chain budget."}
      </footer>
    </main>
  );
}
