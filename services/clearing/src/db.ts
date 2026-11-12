import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Durable state of the clearing service. SQLite in WAL mode: every IOU, job, dispute,
 * settlement and epoch survives a restart, and each epoch's pipeline resumes from the
 * step it reached (each step also checks the chain, so resuming is idempotent).
 *
 * Amounts are stored as INTEGER token base units. They are bounded far below 2^53, so
 * reading them as JS numbers is exact; all arithmetic happens in bigint.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  account_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  logins INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id INTEGER PRIMARY KEY,
  slug TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'agent',
  account TEXT NOT NULL,
  operator TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL,
  card_url TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  services_json TEXT NOT NULL DEFAULT '[]',
  is_validator INTEGER NOT NULL DEFAULT 0,
  is_fleet INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_account ON agents(account);

CREATE TABLE IF NOT EXISTS reputation (
  agent_id INTEGER PRIMARY KEY,
  live_score INTEGER NOT NULL,
  chain_score INTEGER,
  chain_epoch INTEGER,
  inputs_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reputation_history (
  agent_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  score INTEGER NOT NULL,
  previous INTEGER NOT NULL,
  inputs_json TEXT NOT NULL,
  tx TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, epoch)
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  operator_key TEXT NOT NULL,
  buyer INTEGER NOT NULL,
  goal TEXT NOT NULL,
  budget INTEGER NOT NULL,
  per_job_cap INTEGER NOT NULL,
  min_rep INTEGER NOT NULL,
  allowed_services_json TEXT NOT NULL,
  allowed_sellers_json TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  signature TEXT NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  jobs INTEGER NOT NULL DEFAULT 0,
  refusals INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revocation_sig TEXT
);
CREATE INDEX IF NOT EXISTS intents_buyer ON intents(buyer, status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_hash TEXT NOT NULL UNIQUE,
  buyer INTEGER NOT NULL,
  seller INTEGER NOT NULL,
  service TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  price INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  intent_id TEXT,
  quote_json TEXT NOT NULL,
  quote_sig TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  challenge_ends_at INTEGER,
  result_hash TEXT,
  result_json TEXT,
  delivery_sig TEXT,
  delivery_json TEXT,
  parent_job TEXT,
  round_id INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_epoch ON jobs(epoch);
CREATE INDEX IF NOT EXISTS jobs_buyer ON jobs(buyer, created_at);
CREATE INDEX IF NOT EXISTS jobs_seller ON jobs(seller, created_at);
CREATE INDEX IF NOT EXISTS jobs_round ON jobs(round_id) WHERE round_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ious (
  digest TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  epoch INTEGER NOT NULL,
  buyer INTEGER NOT NULL,
  seller INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  token TEXT NOT NULL,
  job_hash TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  nonce_num INTEGER NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,
  posted_epoch INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ious_buyer_nonce ON ious(buyer, nonce_num);
CREATE INDEX IF NOT EXISTS ious_epoch ON ious(epoch, status);

CREATE TABLE IF NOT EXISTS refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  buyer INTEGER,
  seller INTEGER,
  service TEXT,
  amount INTEGER,
  reason TEXT NOT NULL,
  intent_id TEXT
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  iou_digest TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  buyer INTEGER NOT NULL,
  seller INTEGER NOT NULL,
  validator INTEGER,
  arbiter_job_id TEXT,
  reason TEXT NOT NULL,
  filed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  dispute_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reasoning TEXT,
  verdict_sig TEXT,
  decided_at INTEGER,
  request_tx TEXT,
  response_tx TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS disputes_job ON disputes(job_id);

CREATE TABLE IF NOT EXISTS epochs (
  id INTEGER PRIMARY KEY,
  phase TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  intake_ends_at INTEGER NOT NULL,
  challenge_ends_at INTEGER NOT NULL,
  settle_deadline INTEGER,
  iou_count INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL DEFAULT 0,
  debtors INTEGER NOT NULL DEFAULT 0,
  creditors INTEGER NOT NULL DEFAULT 0,
  iou_set_hash TEXT,
  positions_hash TEXT,
  plan_hash TEXT,
  transfers INTEGER NOT NULL DEFAULT 0,
  receipt_hash TEXT,
  finalize_tx TEXT,
  settle_tx TEXT,
  held_out INTEGER NOT NULL DEFAULT 0,
  carried INTEGER NOT NULL DEFAULT 0,
  disputes_upheld INTEGER NOT NULL DEFAULT 0,
  defaults INTEGER NOT NULL DEFAULT 0,
  onchain TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  sealed_at INTEGER
);

CREATE TABLE IF NOT EXISTS epoch_txs (
  hash TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  gas_used INTEGER,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  epoch INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  debit INTEGER NOT NULL,
  net INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (epoch, agent_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  intent_json TEXT,
  intent_hash TEXT,
  submitted_at INTEGER,
  settle_tx TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  deadline INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settlements_epoch_agent ON settlements(epoch, agent_id);

-- the settlement plan: who pays whom, as the contract fixed it at finalisation
CREATE TABLE IF NOT EXISTS transfers (
  epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  from_agent INTEGER NOT NULL,
  to_agent INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  tx TEXT,
  PRIMARY KEY (epoch, seq)
);

-- sealed-bid rounds, mirrored from the contract
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  opener INTEGER NOT NULL,
  service TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  spec_json TEXT,
  chain_json TEXT NOT NULL,
  winner INTEGER,
  clearing_price INTEGER,
  total_quantity INTEGER NOT NULL DEFAULT 0,
  savings INTEGER,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  open_tx TEXT,
  close_tx TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rounds_status ON rounds(status, id);
`;

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(dataDir: string, file = "quorum.sqlite") {
    mkdirSync(dataDir, { recursive: true });
    this.raw = new DatabaseSync(join(dataDir, file));
    this.raw.exec(SCHEMA);
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
}
