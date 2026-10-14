import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import type { Delegation } from "@metamask/smart-accounts-kit";
import { openDatabase } from "./db";
import type {
  AgentRun,
  AgentRunStatus,
  LlmCall,
  LlmCallState,
  MissionEvent,
  MissionPolicy,
  MissionRecord,
  MissionReport,
  MissionStatus,
  PaymentAttempt,
  PaymentErrorKind,
  PaymentState,
  ProviderId,
  Purchase,
  PurchaseState,
  Receipt,
} from "@/shared/types";

const ALLOWED_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  requested: ["authorized", "rejected", "failed"],
  authorized: ["submitted", "rejected", "failed"],
  submitted: ["settled", "rejected", "failed"],
  settled: [],
  rejected: [],
  failed: [],
};

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

type MissionRow = {
  id: string;
  title: string;
  status: string;
  chain_id: number;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  budget: string;
  per_call_max: string;
  recipients: string;
  valid_after: number;
  valid_before: number;
  redeemer: string;
  owner_address: string;
  smart_account_address: string;
  executor_address: string;
  root_delegation: string;
  root_delegation_hash: string;
  enforcer_address: string | null;
  created_at: number;
  updated_at: number;
};

type AttemptRow = {
  id: string;
  mission_id: string;
  agent_run_id: string | null;
  recipient: string;
  amount: string;
  state: string;
  delegation_hash: string | null;
  child_delegation: string | null;
  tx_hash: string | null;
  error_kind: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
};

type PurchaseRow = {
  id: string;
  mission_id: string;
  agent_run_id: string | null;
  payment_id: string;
  provider_id: string;
  request_hash: string;
  response_hash: string | null;
  amount: string;
  pay_to: string;
  state: string;
  error_kind: string | null;
  reason: string | null;
  tx_hash: string | null;
  block_number: number | null;
  spent_after: string | null;
  payer: string | null;
  request_json: string;
  result_json: string | null;
  created_at: number;
  updated_at: number;
};

type LlmCallRow = {
  id: string;
  mission_id: string;
  agent_run_id: string;
  agent_name: string;
  call_index: number;
  model: string;
  fixture: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  state: string;
  error: string | null;
  created_at: number;
};

export interface CreateMissionInput {
  title: string;
  /** Task and addresses are kept as an event so the runner can resume. */
  context?: { task: string; addresses: string[]; scenario?: "research" | "exit-check"; positionUsd?: string };
  policy: MissionPolicy;
  ownerAddress: Address;
  smartAccountAddress: Address;
  executorAddress: Address;
  rootDelegation: Delegation;
  rootDelegationHash: Hex;
  enforcerAddress: Address | null;
  status?: MissionStatus;
}

export interface TransitionPatch {
  delegationHash?: Hex | null;
  childDelegation?: Delegation | null;
  txHash?: Hex | null;
  errorKind?: PaymentErrorKind | null;
  reason?: string | null;
}

function serializePolicy(policy: MissionPolicy): string[] {
  return [policy.budget.toString(), policy.perCallMax.toString()];
}

function deserializePolicy(row: MissionRow): MissionPolicy {
  return {
    chainId: row.chain_id,
    token: {
      address: getAddress(row.token_address),
      symbol: row.token_symbol,
      decimals: row.token_decimals,
    },
    budget: BigInt(row.budget),
    perCallMax: BigInt(row.per_call_max),
    recipients: (JSON.parse(row.recipients) as string[]).map(
      (recipient) => getAddress(recipient) as Address,
    ),
    validAfter: row.valid_after,
    validBefore: row.valid_before,
    redeemer: getAddress(row.redeemer) as Address,
  };
}

function toMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status as MissionStatus,
    policy: deserializePolicy(row),
    ownerAddress: getAddress(row.owner_address) as Address,
    smartAccountAddress: getAddress(row.smart_account_address) as Address,
    executorAddress: getAddress(row.executor_address) as Address,
    rootDelegation: JSON.parse(row.root_delegation) as Delegation,
    rootDelegationHash: row.root_delegation_hash as Hex,
    enforcerAddress: row.enforcer_address
      ? (getAddress(row.enforcer_address) as Address)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRow): PaymentAttempt {
  return {
    id: row.id,
    missionId: row.mission_id,
    agentRunId: row.agent_run_id,
    recipient: getAddress(row.recipient) as Address,
    amount: BigInt(row.amount),
    state: row.state as PaymentState,
    delegationHash: row.delegation_hash as Hex | null,
    childDelegation: row.child_delegation
      ? (JSON.parse(row.child_delegation) as Delegation)
      : null,
    txHash: row.tx_hash as Hex | null,
    errorKind: row.error_kind as PaymentErrorKind | null,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPurchase(row: PurchaseRow): Purchase {
  return {
    id: row.id,
    missionId: row.mission_id,
    agentRunId: row.agent_run_id,
    paymentId: row.payment_id,
    providerId: row.provider_id as ProviderId,
    requestHash: row.request_hash as Hex,
    responseHash: row.response_hash as Hex | null,
    amount: BigInt(row.amount),
    payTo: getAddress(row.pay_to) as Address,
    state: row.state as PurchaseState,
    errorKind: row.error_kind as PaymentErrorKind | null,
    reason: row.reason,
    txHash: row.tx_hash as Hex | null,
    blockNumber: row.block_number,
    spentAfter: row.spent_after === null ? null : BigInt(row.spent_after),
    payer: row.payer ? (getAddress(row.payer) as Address) : null,
    requestJson: row.request_json,
    resultJson: row.result_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLlmCall(row: LlmCallRow): LlmCall {
  return {
    id: row.id,
    missionId: row.mission_id,
    agentRunId: row.agent_run_id,
    agentName: row.agent_name,
    callIndex: row.call_index,
    model: row.model,
    fixture: row.fixture === 1,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cachedTokens: row.cached_tokens,
    state: row.state as LlmCallState,
    error: row.error,
    createdAt: row.created_at,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = openDatabase(path);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- missions

  createMission(input: CreateMissionInput): MissionRecord {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const [budget, perCallMax] = serializePolicy(input.policy);
    this.db
      .prepare(
        `INSERT INTO missions (
          id, title, status, chain_id, token_address, token_symbol, token_decimals,
          budget, per_call_max, recipients, valid_after, valid_before, redeemer,
          owner_address, smart_account_address, executor_address,
          root_delegation, root_delegation_hash, enforcer_address, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.status ?? "active",
        input.policy.chainId,
        input.policy.token.address,
        input.policy.token.symbol,
        input.policy.token.decimals,
        budget,
        perCallMax,
        JSON.stringify(input.policy.recipients),
        input.policy.validAfter,
        input.policy.validBefore,
        input.policy.redeemer,
        input.ownerAddress,
        input.smartAccountAddress,
        input.executorAddress,
        JSON.stringify(input.rootDelegation),
        input.rootDelegationHash,
        input.enforcerAddress,
        now,
        now,
      );
    if (input.context) {
      this.appendEvent({
        missionId: id,
        type: "mission.context",
        payload: { task: input.context.task, addresses: input.context.addresses,
          scenario: input.context.scenario ?? "research", positionUsd: input.context.positionUsd ?? "100" },
      });
    }
    this.appendEvent({
      missionId: id,
      type: "mission.created",
      payload: {
        budget: input.policy.budget.toString(),
        perCallMax: input.policy.perCallMax.toString(),
        token: input.policy.token.address,
      },
    });
    return this.getMission(id);
  }

  getMission(id: string): MissionRecord {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      | MissionRow
      | undefined;
    if (!row) throw new StoreError(`mission not found: ${id}`);
    return toMission(row);
  }

  findMission(id: string): MissionRecord | null {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      | MissionRow
      | undefined;
    return row ? toMission(row) : null;
  }

  findMissionByRootHash(rootDelegationHash: string): MissionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM missions WHERE root_delegation_hash = ?")
      .get(rootDelegationHash) as MissionRow | undefined;
    return row ? toMission(row) : null;
  }

  listMissions(): MissionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM missions ORDER BY created_at DESC")
      .all() as unknown as MissionRow[];
    return rows.map(toMission);
  }

  updateMissionStatus(id: string, status: MissionStatus): void {
    const result = this.db
      .prepare("UPDATE missions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Math.floor(Date.now() / 1000), id);
    if (result.changes === 0) throw new StoreError(`mission not found: ${id}`);
    this.appendEvent({ missionId: id, type: `mission.${status}`, payload: {} });
  }

  // -------------------------------------------------------------- agent runs

  createAgentRun(input: {
    missionId: string;
    agentName: string;
    agentRef?: string | null;
  }): AgentRun {
    this.getMission(input.missionId); // foreign key check with a clear error
    const id = randomUUID();
    const startedAt = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, mission_id, agent_name, agent_ref, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, 'running', ?, NULL)`,
      )
      .run(id, input.missionId, input.agentName, input.agentRef ?? null, startedAt);
    return this.getAgentRun(id);
  }

  getAgentRun(id: string): AgentRun {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | {
          id: string;
          mission_id: string;
          agent_name: string;
          agent_ref: string | null;
          status: string;
          started_at: number;
          ended_at: number | null;
          detail: string | null;
        }
      | undefined;
    if (!row) throw new StoreError(`agent run not found: ${id}`);
    return {
      id: row.id,
      missionId: row.mission_id,
      agentName: row.agent_name,
      agentRef: row.agent_ref,
      status: row.status as AgentRunStatus,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      detail: row.detail ?? null,
    };
  }

  finishAgentRun(
    id: string,
    status: Exclude<AgentRunStatus, "running">,
    detail?: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE agent_runs SET status = ?, ended_at = ?, detail = ? WHERE id = ?",
      )
      .run(status, Math.floor(Date.now() / 1000), detail ?? null, id);
  }

  listAgentRuns(missionId: string): AgentRun[] {
    const rows = this.db
      .prepare("SELECT id FROM agent_runs WHERE mission_id = ? ORDER BY started_at")
      .all(missionId) as unknown as Array<{ id: string }>;
    return rows.map((row) => this.getAgentRun(row.id));
  }

  // --------------------------------------------------------- payment attempts

  createPaymentAttempt(input: {
    missionId: string;
    agentRunId?: string | null;
    recipient: Address;
    amount: bigint;
  }): PaymentAttempt {
    this.getMission(input.missionId);
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO payment_attempts (
          id, mission_id, agent_run_id, recipient, amount, state,
          delegation_hash, child_delegation, tx_hash, error_kind, reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'requested', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.missionId,
        input.agentRunId ?? null,
        input.recipient,
        input.amount.toString(),
        now,
        now,
      );
    this.appendEvent({
      missionId: input.missionId,
      attemptId: id,
      type: "payment.requested",
      payload: { recipient: input.recipient, amount: input.amount.toString() },
    });
    return this.getPaymentAttempt(id);
  }

  getPaymentAttempt(id: string): PaymentAttempt {
    const row = this.db
      .prepare("SELECT * FROM payment_attempts WHERE id = ?")
      .get(id) as AttemptRow | undefined;
    if (!row) throw new StoreError(`payment attempt not found: ${id}`);
    return toAttempt(row);
  }

  listPaymentAttempts(missionId: string): PaymentAttempt[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM payment_attempts WHERE mission_id = ? ORDER BY created_at, rowid",
      )
      .all(missionId) as unknown as AttemptRow[];
    return rows.map(toAttempt);
  }

  /** Applies a state transition, rejecting illegal transitions. */
  transitionPaymentAttempt(
    id: string,
    next: PaymentState,
    patch: TransitionPatch = {},
  ): PaymentAttempt {
    const current = this.getPaymentAttempt(id);
    if (!ALLOWED_TRANSITIONS[current.state].includes(next)) {
      throw new StoreError(
        `illegal payment transition ${current.state} -> ${next} (attempt ${id})`,
      );
    }
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE payment_attempts SET
           state = ?,
           delegation_hash = COALESCE(?, delegation_hash),
           child_delegation = COALESCE(?, child_delegation),
           tx_hash = COALESCE(?, tx_hash),
           error_kind = COALESCE(?, error_kind),
           reason = COALESCE(?, reason),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next,
        patch.delegationHash ?? null,
        patch.childDelegation ? JSON.stringify(patch.childDelegation) : null,
        patch.txHash ?? null,
        patch.errorKind ?? null,
        patch.reason ?? null,
        now,
        id,
      );
    this.appendEvent({
      missionId: current.missionId,
      attemptId: id,
      type: `payment.${next}`,
      payload: {
        from: current.state,
        reason: patch.reason ?? null,
        txHash: patch.txHash ?? null,
      },
    });
    return this.getPaymentAttempt(id);
  }

  // ----------------------------------------------------------------- receipts

  insertReceipt(input: {
    attemptId: string;
    missionId: string;
    txHash: Hex;
    blockNumber: number;
    recipient: Address;
    amount: bigint;
    spentAfter: bigint;
  }): Receipt {
    const attempt = this.getPaymentAttempt(input.attemptId);
    if (attempt.state !== "settled") {
      throw new StoreError(
        `receipt requires a settled attempt, got ${attempt.state}`,
      );
    }
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO receipts (
          id, attempt_id, mission_id, tx_hash, block_number, recipient, amount, spent_after, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.attemptId,
        input.missionId,
        input.txHash,
        input.blockNumber,
        input.recipient,
        input.amount.toString(),
        input.spentAfter.toString(),
        createdAt,
      );
    this.appendEvent({
      missionId: input.missionId,
      attemptId: input.attemptId,
      type: "payment.receipt",
      payload: {
        txHash: input.txHash,
        blockNumber: input.blockNumber,
        spentAfter: input.spentAfter.toString(),
      },
    });
    return this.getReceiptByAttempt(input.attemptId);
  }

  getReceiptByAttempt(attemptId: string): Receipt {
    const row = this.db
      .prepare("SELECT * FROM receipts WHERE attempt_id = ?")
      .get(attemptId) as
      | {
          id: string;
          attempt_id: string;
          mission_id: string;
          tx_hash: string;
          block_number: number;
          recipient: string;
          amount: string;
          spent_after: string;
          created_at: number;
        }
      | undefined;
    if (!row) throw new StoreError(`receipt not found for attempt: ${attemptId}`);
    return {
      id: row.id,
      attemptId: row.attempt_id,
      missionId: row.mission_id,
      txHash: row.tx_hash as Hex,
      blockNumber: row.block_number,
      recipient: getAddress(row.recipient) as Address,
      amount: BigInt(row.amount),
      spentAfter: BigInt(row.spent_after),
      createdAt: row.created_at,
    };
  }

  listReceipts(missionId: string): Receipt[] {
    const rows = this.db
      .prepare(
        "SELECT attempt_id FROM receipts WHERE mission_id = ? ORDER BY created_at, rowid",
      )
      .all(missionId) as unknown as Array<{ attempt_id: string }>;
    return rows.map((row) => this.getReceiptByAttempt(row.attempt_id));
  }

  /** Total settled spend recorded locally (server-side view, not the chain's). */
  computeMissionSpent(missionId: string): bigint {
    const rows = this.db
      .prepare("SELECT amount FROM receipts WHERE mission_id = ?")
      .all(missionId) as unknown as Array<{ amount: string }>;
    // Summed in JS with BigInt on purpose: SQLite would coerce to REAL.
    return rows.reduce((total, row) => total + BigInt(row.amount), 0n);
  }

  // ---------------------------------------------------------------- purchases

  createPurchase(input: {
    missionId: string;
    agentRunId?: string | null;
    paymentId: string;
    providerId: ProviderId;
    requestHash: Hex;
    amount: bigint;
    payTo: Address;
    requestJson: string;
  }): Purchase {
    this.getMission(input.missionId);
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO purchases (
          id, mission_id, agent_run_id, payment_id, provider_id, request_hash,
          response_hash, amount, pay_to, state, error_kind, reason, tx_hash,
          block_number, spent_after, payer, request_json, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.missionId,
        input.agentRunId ?? null,
        input.paymentId,
        input.providerId,
        input.requestHash,
        input.amount.toString(),
        getAddress(input.payTo),
        input.requestJson,
        now,
        now,
      );
    this.appendEvent({
      missionId: input.missionId,
      type: "purchase.pending",
      payload: {
        paymentId: input.paymentId,
        providerId: input.providerId,
        requestHash: input.requestHash,
      },
    });
    return this.getPurchase(id);
  }

  getPurchase(id: string): Purchase {
    const row = this.db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as
      | PurchaseRow
      | undefined;
    if (!row) throw new StoreError(`purchase not found: ${id}`);
    return toPurchase(row);
  }

  getPurchaseByPaymentId(
    providerId: ProviderId,
    paymentId: string,
  ): Purchase | null {
    const row = this.db
      .prepare(
        "SELECT * FROM purchases WHERE provider_id = ? AND payment_id = ?",
      )
      .get(providerId, paymentId) as PurchaseRow | undefined;
    return row ? toPurchase(row) : null;
  }

  listPurchases(missionId: string): Purchase[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM purchases WHERE mission_id = ? ORDER BY created_at, rowid",
      )
      .all(missionId) as unknown as PurchaseRow[];
    return rows.map(toPurchase);
  }

  /** Terminal-state purchase update; pending -> settled/rejected/failed only. */
  transitionPurchase(
    id: string,
    state: Exclude<PurchaseState, "pending">,
    patch: {
      responseHash?: Hex | null;
      errorKind?: PaymentErrorKind | null;
      reason?: string | null;
      txHash?: Hex | null;
      blockNumber?: number | null;
      spentAfter?: bigint | null;
      payer?: Address | null;
      resultJson?: string | null;
    } = {},
  ): Purchase {
    const current = this.getPurchase(id);
    if (current.state !== "pending") {
      throw new StoreError(
        `illegal purchase transition ${current.state} -> ${state} (purchase ${id})`,
      );
    }
    this.db
      .prepare(
        `UPDATE purchases SET
           state = ?,
           response_hash = COALESCE(?, response_hash),
           error_kind = COALESCE(?, error_kind),
           reason = COALESCE(?, reason),
           tx_hash = COALESCE(?, tx_hash),
           block_number = COALESCE(?, block_number),
           spent_after = COALESCE(?, spent_after),
           payer = COALESCE(?, payer),
           result_json = COALESCE(?, result_json),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        patch.responseHash ?? null,
        patch.errorKind ?? null,
        patch.reason ?? null,
        patch.txHash ?? null,
        patch.blockNumber ?? null,
        patch.spentAfter !== null && patch.spentAfter !== undefined
          ? patch.spentAfter.toString()
          : null,
        patch.payer ?? null,
        patch.resultJson ?? null,
        Math.floor(Date.now() / 1000),
        id,
      );
    this.appendEvent({
      missionId: current.missionId,
      type: `purchase.${state}`,
      payload: {
        paymentId: current.paymentId,
        providerId: current.providerId,
        txHash: patch.txHash ?? null,
        reason: patch.reason ?? null,
      },
    });
    return this.getPurchase(id);
  }

  /**
   * Attaches a result to an already-settled purchase (used when the on-chain
   * payment confirmed but the RPC data read failed and is retried).
   */
  completePurchaseResult(
    id: string,
    patch: { responseHash: Hex; resultJson: string },
  ): Purchase {
    const current = this.getPurchase(id);
    if (current.state !== "settled") {
      throw new StoreError(
        `cannot attach a result to a ${current.state} purchase (${id})`,
      );
    }
    this.db
      .prepare(
        `UPDATE purchases SET response_hash = ?, result_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(patch.responseHash, patch.resultJson, Math.floor(Date.now() / 1000), id);
    return this.getPurchase(id);
  }

  // ---------------------------------------------------------------- llm calls

  recordLlmCall(input: {
    missionId: string;
    agentRunId: string;
    agentName: string;
    callIndex: number;
    model: string;
    fixture?: boolean;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    cachedTokens?: number | null;
    state: LlmCallState;
    error?: string | null;
  }): LlmCall {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO llm_calls (
          id, mission_id, agent_run_id, agent_name, call_index, model, fixture,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens, state,
          error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.missionId,
        input.agentRunId,
        input.agentName,
        input.callIndex,
        input.model,
        input.fixture ? 1 : 0,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.totalTokens ?? null,
        input.cachedTokens ?? null,
        input.state,
        input.error ?? null,
        createdAt,
      );
    return this.getLlmCall(id);
  }

  getLlmCall(id: string): LlmCall {
    const row = this.db.prepare("SELECT * FROM llm_calls WHERE id = ?").get(id) as
      | LlmCallRow
      | undefined;
    if (!row) throw new StoreError(`llm call not found: ${id}`);
    return toLlmCall(row);
  }

  listLlmCalls(missionId: string): LlmCall[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM llm_calls WHERE mission_id = ? ORDER BY created_at, rowid",
      )
      .all(missionId) as unknown as LlmCallRow[];
    return rows.map(toLlmCall);
  }

  computeLlmUsage(missionId: string): {
    calls: number;
    fixtureCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } {
    const calls = this.listLlmCalls(missionId);
    return calls.reduce(
      (summary, call) => ({
        calls: summary.calls + 1,
        fixtureCalls: summary.fixtureCalls + (call.fixture ? 1 : 0),
        promptTokens: summary.promptTokens + (call.promptTokens ?? 0),
        completionTokens: summary.completionTokens + (call.completionTokens ?? 0),
        totalTokens: summary.totalTokens + (call.totalTokens ?? 0),
      }),
      { calls: 0, fixtureCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );
  }

  // ------------------------------------------------------------------ reports

  saveReport(report: MissionReport): void {
    this.getMission(report.missionId);
    this.db
      .prepare(
        `INSERT INTO reports (mission_id, content, created_at) VALUES (?, ?, ?)
         ON CONFLICT(mission_id) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`,
      )
      .run(report.missionId, JSON.stringify(report), Math.floor(Date.now() / 1000));
    this.appendEvent({
      missionId: report.missionId,
      type: "report.saved",
      payload: { sources: report.sources.length, refusals: report.refusals.length },
    });
  }

  getReport(missionId: string): MissionReport | null {
    const row = this.db
      .prepare("SELECT content FROM reports WHERE mission_id = ?")
      .get(missionId) as { content: string } | undefined;
    return row ? (JSON.parse(row.content) as MissionReport) : null;
  }

  // ------------------------------------------------------------------- events

  appendEvent(input: {
    missionId?: string | null;
    attemptId?: string | null;
    type: string;
    payload: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (mission_id, attempt_id, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.missionId ?? null,
        input.attemptId ?? null,
        input.type,
        JSON.stringify(input.payload),
        Math.floor(Date.now() / 1000),
      );
  }

  listEvents(missionId: string): MissionEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE mission_id = ? ORDER BY id ASC",
      )
      .all(missionId) as unknown as Array<{
      id: number;
      mission_id: string | null;
      attempt_id: string | null;
      type: string;
      payload: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      attemptId: row.attempt_id,
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }
}
