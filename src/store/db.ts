import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite schema for missions, agent runs, payment attempts, receipts, x402
 * purchases, LLM usage and reports. `node:sqlite` is built into Node 24, so no
 * native module is required.
 */
export const SCHEMA_VERSION = 2;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  budget TEXT NOT NULL,
  per_call_max TEXT NOT NULL,
  recipients TEXT NOT NULL,
  valid_after INTEGER NOT NULL,
  valid_before INTEGER NOT NULL,
  redeemer TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  smart_account_address TEXT NOT NULL,
  executor_address TEXT NOT NULL,
  root_delegation TEXT NOT NULL,
  root_delegation_hash TEXT NOT NULL,
  enforcer_address TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  agent_name TEXT NOT NULL,
  agent_ref TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  agent_run_id TEXT REFERENCES agent_runs(id),
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL,
  delegation_hash TEXT,
  child_delegation TEXT,
  tx_hash TEXT,
  error_kind TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  spent_after TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT,
  attempt_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_mission ON payment_attempts(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_receipts_mission ON receipts(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id, id);
`;

const MIGRATION_2 = `
ALTER TABLE agent_runs ADD COLUMN detail TEXT;

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  agent_run_id TEXT REFERENCES agent_runs(id),
  payment_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  amount TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  state TEXT NOT NULL,
  error_kind TEXT,
  reason TEXT,
  tx_hash TEXT,
  block_number INTEGER,
  spent_after TEXT,
  payer TEXT,
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_id, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_purchases_mission ON purchases(mission_id, created_at);

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  agent_name TEXT NOT NULL,
  call_index INTEGER NOT NULL,
  model TEXT NOT NULL,
  fixture INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cached_tokens INTEGER,
  state TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_mission ON llm_calls(mission_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  for (const migration of MIGRATIONS) {
    if (current < migration.version) {
      db.exec(migration.sql);
    }
  }
  if (row) {
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  } else {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  }
}
