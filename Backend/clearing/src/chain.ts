import { NETWORKS, NearAccount, implicitAccountId, NearError, NearRpc, TGAS, intentsTokenId, type AccountId, type Deployment, type Hex, type NetworkKey, type PublicKey, type TxResult } from "@yuki/core";
import { log } from "./bus.ts";

export interface VaultAccount {
  total: bigint;
  locked: bigint;
  pendingWithdrawal: bigint;
  unlockAt: number;
  available: bigint;
}

export interface OnchainAgent {
  agentId: bigint;
  account: AccountId;
  operator: AccountId;
  publicKey: PublicKey;
  status: "active" | "paused" | "retired";
  uri: string;
}

/** `get_epoch` on the coordinator, as returned. */
export interface ChainEpoch {
  id: number;
  status: "Open" | "Posting" | "Finalized" | "Sealed";
  iou_count: number;
  carried_count: number;
  held_out_count: number;
  gross_volume: string;
  net_volume: string;
  debtor_count: number;
  creditor_count: number;
  open_debtors: number;
  default_count: number;
  iou_set_hash: Hex;
  positions_hash: Hex;
  plan_hash: Hex;
  settlements_hash: Hex;
  receipt_hash: Hex;
  participants: number[];
  plan: { from: number; to: number; amount: string }[];
  finalized_at: number;
  settle_deadline: number;
  sealed_at: number;
}

export type ChainPositionState = "Flat" | "Owes" | "Submitted" | "Settled" | "Defaulted" | "Creditor";

/** `get_round` on the coordinator, as returned. */
export interface ChainRound {
  id: number;
  kind: "Tender" | "GroupBuy";
  pricing: "FirstPrice" | "SecondPrice";
  status: "Open" | "Closed" | "Void";
  opener: number;
  service: string;
  spec_hash: Hex;
  reserve_price: string;
  min_reputation: number;
  opened_at: number;
  join_deadline: number;
  commit_deadline: number;
  reveal_deadline: number;
  closed_at: number;
  demand: { buyer: number; quantity: number; max_price: string }[];
  bids: { seller: number; commitment: Hex; committed_at: number; price: string | null; revealed_at: number }[];
  winner: number | null;
  clearing_price: string;
  total_quantity: number;
  allocations: { buyer: number; quantity: number; cost: string }[];
  void_reason: string;
}

interface RawAgent {
  id: number;
  account: string;
  operator: string;
  public_key: string;
  uri: string;
  status: "Active" | "Paused" | "Retired";
}

/**
 * Chain access for the clearing service. Every write is a function call on the
 * coordinator contract from the clearer's account; the account sends one transaction at
 * a time, so the clearer never races itself on nonces.
 */
export class Chain {
  readonly key: NetworkKey;
  readonly rpc: NearRpc;
  readonly account: NearAccount;
  readonly d: Deployment;
  healthy = true;
  /** when an RPC call last failed (0: never) */
  rpcTroubleAt = 0;
  lastBlock = 0;
  lastError: string | null = null;
  private keyChecks = new Map<string, { at: number; ok: boolean }>();

  constructor(key: NetworkKey, rpcUrl: string, clearerSecretKey: string, deployment: Deployment) {
    this.key = key;
    this.d = deployment;
    // A fresh start on a public network has not seen the RPC work yet: it may be restarting into an outage.
    this.rpcTroubleAt = key === "local" ? 0 : Date.now();
    this.rpc = new NearRpc(rpcUrl, {
      onTrouble: () => {
        this.rpcTroubleAt = Date.now();
      },
    });
    this.account = new NearAccount(this.rpc, deployment.clearer, clearerSecretKey);
  }

  get explorer(): string | null {
    return NETWORKS[this.key].explorer;
  }

  get networkName(): string {
    return NETWORKS[this.key].name;
  }

  // ---------------------------------------------------------------- writes

  /** Call a method on the coordinator and wait for every receipt. Throws with the contract's own reason. */
  async write<T = unknown>(label: string, method: string, args: unknown, gasTgas = 100): Promise<TxResult<T>> {
    const started = Date.now();
    try {
      const r = await this.account.call<T>(this.d.contract, method, args, { gas: BigInt(gasTgas) * TGAS });
      this.healthy = true;
      this.lastError = null;
      log("info", "chain", `${label} ok in ${Date.now() - started}ms (${Number(r.gasBurnt / TGAS)} Tgas) ${r.hash}`);
      return r;
    } catch (err) {
      const reason = revertReason(err);
      this.lastError = `${label}: ${reason}`;
      if (!(err instanceof NearError && err.kind === "failure")) this.healthy = false;
      throw new Error(`${label} failed: ${reason}`);
    }
  }

  // ---------------------------------------------------------------- reads

  private view<T>(method: string, args: unknown = {}): Promise<T> {
    return this.rpc.view<T>(this.d.contract, method, args);
  }

  async ping(): Promise<boolean> {
    try {
      this.lastBlock = (await this.rpc.latestBlock()).height;
      this.healthy = true;
      return true;
    } catch (err) {
      this.healthy = false;
      this.lastError = revertReason(err);
      return false;
    }
  }

  /** The chain's own clock, which deadlines in the contract are measured against. */
  async blockTimeMs(): Promise<number> {
    return (await this.rpc.latestBlock()).timestampMs;
  }

  async config(): Promise<{ current_epoch: number; agent_count: number; round_count: number; settlement_window_ms: number; clearer: string; token: string; intents: string }> {
    return this.view("get_config");
  }

  async totalAgents(): Promise<number> {
    return (await this.config()).agent_count;
  }

  async agents(from: number, limit: number): Promise<OnchainAgent[]> {
    return (await this.view<RawAgent[]>("get_agents", { from, limit })).map(toAgent);
  }

  async agent(agentId: bigint): Promise<OnchainAgent> {
    const a = await this.view<RawAgent | null>("get_agent", { agent_id: Number(agentId) });
    if (!a) throw new Error(`agent #${agentId} is not registered`);
    return toAgent(a);
  }

  async vaultAccount(agentId: bigint): Promise<VaultAccount> {
    const c = await this.view<{ total: string; locked: string; pending_withdrawal: string; withdrawal_requested_at: number }>("get_collateral", { agent_id: Number(agentId) });
    const total = BigInt(c.total);
    const locked = BigInt(c.locked);
    const pending = BigInt(c.pending_withdrawal);
    const free = total - locked - pending;
    return {
      total,
      locked,
      pendingWithdrawal: pending,
      unlockAt: c.withdrawal_requested_at ? c.withdrawal_requested_at + this.d.withdrawalDelayMs : 0,
      available: free > 0n ? free : 0n,
    };
  }

  async currentEpoch(): Promise<bigint> {
    return BigInt((await this.config()).current_epoch);
  }

  /** null until the epoch has had its first posting call. */
  epoch(epochId: bigint | number): Promise<ChainEpoch | null> {
    return this.view<ChainEpoch | null>("get_epoch", { epoch: Number(epochId) });
  }

  async position(epochId: bigint | number, agentId: bigint | number): Promise<{ credit: bigint; debit: bigint; net: bigint; state: ChainPositionState } | null> {
    const p = await this.view<{ credit: string; debit: string; net: string; state: ChainPositionState } | null>("get_position", { epoch: Number(epochId), agent_id: Number(agentId) });
    return p ? { credit: BigInt(p.credit), debit: BigInt(p.debit), net: BigInt(p.net), state: p.state } : null;
  }

  heldOut(digest: Hex): Promise<number> {
    return this.view<number>("held_out_epoch", { digest });
  }

  async lastNonce(buyer: bigint): Promise<bigint> {
    return BigInt(await this.view<string>("last_nonce_of", { agent_id: Number(buyer) }));
  }

  reputationOf(agentId: bigint | number): Promise<number> {
    return this.view<number>("reputation_of", { agent_id: Number(agentId) });
  }

  round(roundId: number): Promise<ChainRound | null> {
    return this.view<ChainRound | null>("get_round", { round_id: roundId });
  }

  rounds(from: number, limit: number): Promise<ChainRound[]> {
    return this.view<ChainRound[]>("get_rounds", { from, limit });
  }

  async roundCount(): Promise<number> {
    return (await this.config()).round_count;
  }

  /** An account's spendable balance of the settlement token inside the verifier. */
  async intentsBalance(account: AccountId): Promise<bigint> {
    return BigInt(await this.rpc.view<string>(this.d.intents, "mt_balance_of", { account_id: account, token_id: intentsTokenId(this.d.token) }));
  }

  /** Does the verifier accept this key for this account? */
  intentsKeyRegistered(account: AccountId, publicKey: PublicKey): Promise<boolean> {
    return this.rpc.view<boolean>(this.d.intents, "has_public_key", { account_id: account, public_key: publicKey });
  }

  /** Is `publicKey` an access key of `account` right now? Cached for a minute. */
  private otherRpc = new Map<NetworkKey, NearRpc>();

  /**
   * A key that can sign for the account in full: what a human operator authorises with.
   * People sign in with the account they have, so a testnet deployment also checks mainnet keys.
   */
  async holdsFullAccessKey(account: AccountId, publicKey: PublicKey, network: NetworkKey = this.key): Promise<boolean> {
    // an implicit account is named after its own key: the signature proves it, funded or not
    if (/^[0-9a-f]{64}$/.test(account)) {
      try {
        if (implicitAccountId(publicKey) === account) return true;
      } catch {
        return false;
      }
    }
    const k = `full|${network}|${account}|${publicKey}`;
    const hit = this.keyChecks.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    let rpc = this.rpc;
    if (network !== this.key) {
      rpc = this.otherRpc.get(network) ?? new NearRpc(NETWORKS[network].rpcUrl);
      this.otherRpc.set(network, rpc);
    }
    const ok = (await rpc.accessKey(account, publicKey))?.fullAccess === true;
    this.keyChecks.set(k, { at: Date.now(), ok });
    return ok;
  }

  async holdsKey(account: AccountId, publicKey: PublicKey): Promise<boolean> {
    const k = `${account}|${publicKey}`;
    const hit = this.keyChecks.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const ok = (await this.rpc.accessKey(account, publicKey)) !== null;
    this.keyChecks.set(k, { at: Date.now(), ok });
    return ok;
  }
}

function toAgent(a: RawAgent): OnchainAgent {
  return { agentId: BigInt(a.id), account: a.account, operator: a.operator, publicKey: a.public_key, status: a.status.toLowerCase() as OnchainAgent["status"], uri: a.uri };
}

export function revertReason(err: unknown): string {
  if (err instanceof NearError) return err.panic ?? err.message;
  return err instanceof Error ? err.message : String(err);
}
