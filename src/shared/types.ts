/**
 * Domain types shared by the payment core, the store and (future) agents/UI.
 *
 * Money is always represented as a bigint in the token's minimal units
 * (for USDC with 6 decimals: 0.05 = 50_000n, 0.02 = 20_000n). No floats.
 */
import type { Address, Hex } from "viem";
import type { Delegation } from "@metamask/smart-accounts-kit";
import type { ExitCheckReport } from "./exit-check";

export const PAYMENT_STATES = [
  "requested",
  "authorized",
  "submitted",
  "settled",
  "rejected",
  "failed",
] as const;

/**
 * requested  – intent recorded, nothing signed yet
 * authorized – a one-shot child delegation was signed for these exact parameters
 * submitted  – the redemption transaction was broadcast
 * settled    – the redemption was mined successfully
 * rejected   – a policy (server-side or on-chain caveat) refused the payment
 * failed     – infrastructure error (RPC, gas, nonce, unexpected revert)
 */
export type PaymentState = (typeof PAYMENT_STATES)[number];

export type PaymentErrorKind = "policy" | "infrastructure";

export type MissionStatus = "active" | "revoked" | "expired" | "completed";

export type AgentRunStatus = "running" | "completed" | "failed";

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface MissionPolicy {
  chainId: number;
  token: TokenInfo;
  /** Total mission budget in minimal units. */
  budget: bigint;
  /** Hard cap for a single payment in minimal units. */
  perCallMax: bigint;
  /** 1 or 2 addresses that may receive mission funds. */
  recipients: readonly Address[];
  /** Unix seconds. */
  validAfter: number;
  validBefore: number;
  /** Only this address may redeem the mission permission. */
  redeemer: Address;
}

export interface MissionRecord {
  id: string;
  title: string;
  status: MissionStatus;
  policy: MissionPolicy;
  /** EOA that owns the MetaMask smart account; its key never reaches the agent runtime. */
  ownerAddress: Address;
  /** MetaMask Hybrid delegator that holds the USDC and signs the root delegation. */
  smartAccountAddress: Address;
  /** Server-side executor EOA. Creates child delegations and redeems them. */
  executorAddress: Address;
  rootDelegation: Delegation;
  rootDelegationHash: Hex;
  /** Address of the custom MissionPolicyEnforcer used by this mission, if any. */
  enforcerAddress: Address | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRun {
  id: string;
  missionId: string;
  agentName: string;
  agentRef: string | null;
  status: AgentRunStatus;
  startedAt: number;
  endedAt: number | null;
  /** Final summary or failure reason. */
  detail: string | null;
}

export interface PaymentAttempt {
  id: string;
  missionId: string;
  agentRunId: string | null;
  recipient: Address;
  amount: bigint;
  state: PaymentState;
  /** Hash of the one-shot child delegation that authorizes this attempt. */
  delegationHash: Hex | null;
  /** The signed child delegation (leaf of the chain), if it was created. */
  childDelegation: Delegation | null;
  txHash: Hex | null;
  errorKind: PaymentErrorKind | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Receipt {
  id: string;
  attemptId: string;
  missionId: string;
  txHash: Hex;
  blockNumber: number;
  recipient: Address;
  amount: bigint;
  /** Root delegation spend reported by the ERC20TransferAmountEnforcer after settlement. */
  spentAfter: bigint;
  createdAt: number;
}

export interface MissionEvent {
  id: number;
  missionId: string | null;
  attemptId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface PaymentRequest {
  missionId: string;
  agentRunId?: string | null;
  recipient: Address;
  /** Amount in minimal units. */
  amount: bigint;
}

// ---------------------------------------------------------------- x402 / agents

/** Registered paid data providers. The model can never pick an arbitrary URL. */
export type ProviderId = "code" | "activity" | "market" | "exit";

export const PROVIDER_IDS: readonly ProviderId[] = ["code", "activity", "market", "exit"];

export type PurchaseState = "pending" | "settled" | "rejected" | "failed";

/** One paid HTTP purchase: the journal entry required by the mission log. */
export interface Purchase {
  id: string;
  missionId: string;
  agentRunId: string | null;
  /** Unique client-generated id; a repeat with the same id never charges twice. */
  paymentId: string;
  providerId: ProviderId;
  /** keccak256 of the canonical request payload (provider + arguments). */
  requestHash: Hex;
  /** keccak256 of the served result body; null until served. */
  responseHash: Hex | null;
  amount: bigint;
  payTo: Address;
  state: PurchaseState;
  errorKind: PaymentErrorKind | null;
  reason: string | null;
  txHash: Hex | null;
  blockNumber: number | null;
  /** Root enforcer spend after this purchase, when known. */
  spentAfter: bigint | null;
  /** Delegator (smart account) reported by the x402 payload. */
  payer: Address | null;
  /** JSON of validated request arguments (no secrets). */
  requestJson: string;
  /** JSON of the paid result body, cached for idempotent replays. */
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export type LlmCallState = "ok" | "failed" | "rate_limited" | "no_balance";

export interface LlmCall {
  id: string;
  missionId: string;
  agentRunId: string;
  agentName: string;
  callIndex: number;
  model: string;
  fixture: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  state: LlmCallState;
  error: string | null;
  createdAt: number;
}

export interface MissionReport {
  missionId: string;
  task: string;
  addresses: Address[];
  createdAt: number;
  /** Free-form summary assembled from the agents' final messages. */
  summary: string;
  exitCheck?: ExitCheckReport;
  agentSummaries: Array<{
    agentName: string;
    status: AgentRunStatus;
    summary: string;
    error: string | null;
  }>;
  /** Every settled purchase is a citable source. */
  sources: Array<{
    paymentId?: string;
    providerId: ProviderId;
    request: Record<string, unknown>;
    blockNumber: number | null;
    settlementBlockNumber?: number | null;
    txHash: Hex | null;
    amount: string;
    responseHash: Hex | null;
  }>;
  /** Refusals and infrastructure failures, with reasons. */
  refusals: Array<{
    providerId: ProviderId;
    request: Record<string, unknown>;
    state: PurchaseState;
    reason: string | null;
  }>;
  budget: {
    budget: string;
    perCallMax: string;
    spent: string;
    remaining: string;
  };
  llm: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
