import { intentsTokenId, parseSignedIntent, type PlanTransfer, type SettlementOrder, type SignedIntent } from "@quorum/core";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { Registry } from "./registry.ts";
import { bus, log } from "./bus.ts";
import { epochView, settlementView, transferView, type EpochRow, type SettlementRow, type TransferRow } from "./views.ts";

const DEFAULT_GRACE_MS = 3_000;
/** how long the RPC must have worked without a failure before a debtor is defaulted */
const RPC_STEADY_MS = 10 * 60_000;
/** past this, a debt is defaulted even if the RPC is still flaky */
const MAX_DEFER_MS = 2 * 60 * 60_000;

export interface SettlementOptions {
  /** debtors' payloads per `settle` call */
  chunkSize: number;
  /** how long to wait for the remaining debtors before sending a partial batch */
  gatherMs: number;
}

export class SettlementError extends Error {}

/**
 * Settlement of net debts through NEAR Intents.
 *
 *   awaiting_payment -> submitted -> recorded      (paid through the verifier)
 *   awaiting_payment -> defaulted                  (missed the deadline, covered from collateral)
 *
 * At finalisation the contract fixes a plan: which debtor pays which creditor how much.
 * Each debtor signs one NEP-413 payload of `transfer` intents for exactly its lines and
 * hands it to this service. The service gathers the payloads and calls `settle` on the
 * coordinator, which checks every payload against its own plan and forwards the batch to
 * the verifier's `execute_intents`. The verifier executes it atomically, creditors are
 * paid directly inside the verifier, and the contract marks the debtors settled in the
 * callback. A debt is only ever shown as paid after the chain says so.
 */
export class Settlements {
  private defaulting = new Set<string>();
  private sending = new Set<number>();
  /** set while a tick runs: the timer fires every 2 s, but a tick waits on the chain */
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
    private readonly registry: Registry,
    private readonly opts: SettlementOptions,
    private readonly onSealed: (epoch: number) => void,
  ) {}

  createOrders(epoch: number, debtors: { agentId: bigint; owed: bigint }[], deadline: number, plan: PlanTransfer[]): void {
    const now = Date.now();
    this.db.tx(() => {
      plan.forEach((t, seq) => {
        this.db.run(
          "INSERT INTO transfers(epoch, seq, from_agent, to_agent, amount) VALUES (?,?,?,?,?) ON CONFLICT(epoch, seq) DO NOTHING",
          epoch,
          seq,
          Number(t.from),
          Number(t.to),
          Number(t.amount),
        );
      });
      for (const d of debtors) {
        this.db.run(
          `INSERT INTO settlements(id, epoch, agent_id, amount, status, deadline, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(epoch, agent_id) DO NOTHING`,
          settlementId(epoch, d.agentId),
          epoch,
          Number(d.agentId),
          Number(d.owed),
          "awaiting_payment",
          deadline,
          now,
          now,
        );
      }
    });
    for (const d of debtors) this.emit(settlementId(epoch, d.agentId));
  }

  /** What a debtor has to sign: its lines of the plan, with the creditors' accounts. */
  order(row: SettlementRow): SettlementOrder {
    const lines = this.db.all<TransferRow>("SELECT * FROM transfers WHERE epoch = ? AND from_agent = ? ORDER BY seq", row.epoch, row.agent_id);
    return {
      id: row.id,
      epoch: row.epoch,
      agentId: String(row.agent_id),
      account: this.registry.get(row.agent_id)?.account ?? "",
      amount: String(row.amount),
      token: this.chain.d.token,
      contract: this.chain.d.contract,
      verifier: this.chain.d.intents,
      verifierKind: this.chain.d.intentsKind,
      deadline: row.deadline,
      transfers: lines.map((t) => ({ to: String(t.to_agent), receiver: this.registry.get(t.to_agent)?.account ?? "", amount: String(t.amount) })),
    };
  }

  get(id: string): SettlementRow | undefined {
    return this.db.get<SettlementRow>("SELECT * FROM settlements WHERE id = ?", id);
  }

  list(filter: { agentId?: string; status?: string; epoch?: number; limit?: number }): SettlementRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.agentId) {
      where.push("agent_id = ?");
      params.push(Number(filter.agentId));
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.epoch !== undefined) {
      where.push("epoch = ?");
      params.push(filter.epoch);
    }
    return this.db.all<SettlementRow>(
      `SELECT * FROM settlements ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY epoch DESC, agent_id LIMIT ?`,
      ...params,
      filter.limit ?? 200,
    );
  }

  transfers(epoch: number): TransferRow[] {
    return this.db.all<TransferRow>("SELECT * FROM transfers WHERE epoch = ? ORDER BY seq", epoch);
  }

  /**
   * A debtor hands in its signed payload. It is checked here with the same rules the
   * contract applies, so a payload that would be refused on chain never costs a transaction.
   */
  async submit(id: string, signed: SignedIntent): Promise<SettlementRow> {
    const row = this.get(id);
    if (!row) throw new SettlementError("unknown settlement");
    if (row.status === "recorded" || row.status === "submitted") return row;
    if (row.status === "defaulted") throw new SettlementError("this debt was already covered from collateral");
    const order = this.order(row);
    const parsed = parseSignedIntent(signed);
    if (!parsed) throw new SettlementError("the payload is not a correctly signed NEP-413 intent");
    if (signed.payload.recipient !== order.verifier) throw new SettlementError(`the payload is addressed to ${signed.payload.recipient}; this deployment settles through ${order.verifier}`);
    if (parsed.signerId !== order.account) throw new SettlementError(`the payload is signed for ${parsed.signerId}; this debt belongs to ${order.account}`);
    if (parsed.deadline < Date.now() + 60_000) throw new SettlementError("the payload expires too soon");
    const tokenId = intentsTokenId(order.token);
    if (parsed.intents.length !== order.transfers.length) throw new SettlementError(`the plan has ${order.transfers.length} transfer(s) for this debt; the payload has ${parsed.intents.length}`);
    order.transfers.forEach((want, i) => {
      const got = parsed.intents[i]!;
      const tokens = Object.entries(got.tokens ?? {});
      if (got.intent !== "transfer" || got.receiver_id !== want.receiver || tokens.length !== 1 || tokens[0]![0] !== tokenId || tokens[0]![1] !== want.amount) {
        throw new SettlementError(`transfer ${i + 1} must pay ${want.amount} of ${tokenId} to ${want.receiver}`);
      }
    });
    if (!(await this.chain.intentsKeyRegistered(order.account, signed.public_key))) {
      throw new SettlementError(`${signed.public_key} is not registered with ${order.verifier} for ${order.account}: call add_public_key first`);
    }
    const balance = await this.chain.intentsBalance(order.account);
    if (balance < BigInt(row.amount)) {
      throw new SettlementError(`${order.account} holds ${balance} of ${tokenId} inside ${order.verifier} and owes ${row.amount}: deposit the difference first`);
    }
    this.db.run(
      "UPDATE settlements SET status = 'submitted', intent_json = ?, intent_hash = ?, submitted_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'",
      JSON.stringify(signed),
      parsed.hash,
      Date.now(),
      Date.now(),
      id,
    );
    this.emit(id);
    void this.tick();
    return this.get(id)!;
  }

  /** Called on a timer: batches, deadlines, defaults and seals. */
  async tick(): Promise<void> {
    // One tick at a time. Every await below has a timeout, so a tick always ends.
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const e of this.db.all<EpochRow>("SELECT * FROM epochs WHERE phase = 'settling' ORDER BY id")) {
        try {
          await this.drive(e);
        } catch (err) {
          log("warn", "settlement", `epoch ${e.id}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async drive(e: EpochRow): Promise<void> {
    const rows = this.list({ epoch: e.id });
    const open = rows.filter((r) => r.status !== "recorded" && r.status !== "defaulted");
    const submitted = open.filter((r) => r.status === "submitted");
    const waiting = open.filter((r) => r.status === "awaiting_payment");
    const deadline = e.settle_deadline ?? Infinity;
    const now = Date.now();

    // Send what is in hand once everyone has signed, or the gather window has passed, or the
    // deadline is close. One transaction settles every debtor in the chunk, all or nothing.
    if (submitted.length) {
      const oldest = Math.min(...submitted.map((r) => r.submitted_at ?? now));
      if (waiting.length === 0 || now - oldest >= this.opts.gatherMs || now >= deadline - 10_000) {
        for (let i = 0; i < submitted.length; i += this.opts.chunkSize) await this.send(e.id, submitted.slice(i, i + this.opts.chunkSize));
      }
    }

    const stillWaiting = this.list({ epoch: e.id }).filter((r) => r.status === "awaiting_payment");
    if (stillWaiting.length > 0 && now > deadline + DEFAULT_GRACE_MS) {
      // the contract compares against block time, which can lag the wall clock on a quiet chain
      const chainNow = await this.chain.blockTimeMs().catch(() => 0);
      // No debtor is defaulted for a deadline that passed while this service could not reach the
      // chain (its payload could not be forwarded either): defaults wait until the RPC has been
      // steady for a while, up to a hard cap so a flaky RPC cannot shield a debtor that never pays.
      const steady = now - this.chain.rpcTroubleAt >= RPC_STEADY_MS;
      const mustDecide = now >= deadline + MAX_DEFER_MS;
      if (chainNow > deadline && (steady || mustDecide)) {
        for (const r of stillWaiting) {
          const fresh = this.get(r.id);
          if (fresh?.status === "awaiting_payment") await this.default(fresh);
        }
      }
    }

    const left = this.list({ epoch: e.id }).filter((r) => r.status !== "recorded" && r.status !== "defaulted");
    if (left.length === 0) await this.seal(e.id);
  }

  /** Forward a batch of signed payloads through the coordinator. Falls back to one by one to find a bad payload. */
  private async send(epoch: number, rows: SettlementRow[]): Promise<void> {
    if (this.sending.has(epoch) || rows.length === 0) return;
    this.sending.add(epoch);
    try {
      const signed = rows.map((r) => JSON.parse(r.intent_json!) as SignedIntent);
      let executed = false;
      let hash: string | null = null;
      let failure: string | null = null;
      try {
        const r = await this.chain.write<boolean>(`settle e${epoch} (${rows.length} debtor${rows.length === 1 ? "" : "s"})`, "settle", { epoch, signed }, 300);
        executed = r.value === true;
        hash = r.hash;
        if (!executed) failure = "the verifier refused the batch";
      } catch (err) {
        failure = (err as Error).message;
      }
      if (executed) {
        const now = Date.now();
        this.db.tx(() => {
          for (const r of rows) {
            this.db.run("UPDATE settlements SET status = 'recorded', settle_tx = ?, error = NULL, updated_at = ? WHERE id = ?", hash, now, r.id);
            this.db.run("UPDATE positions SET state = 'settled' WHERE epoch = ? AND agent_id = ?", epoch, r.agent_id);
            this.db.run("UPDATE transfers SET status = 'settled', tx = ? WHERE epoch = ? AND from_agent = ?", hash, epoch, r.agent_id);
          }
          this.db.run("UPDATE epochs SET settle_tx = ? WHERE id = ?", hash, epoch);
          this.db.run("INSERT OR IGNORE INTO epoch_txs(hash, epoch, kind, gas_used, at) VALUES (?,?,?,?,?)", hash, epoch, "settle", null, now);
        });
        log("info", "settlement", `epoch ${epoch}: ${rows.length} debtor(s) settled through ${this.chain.d.intents} in one transaction ${hash}`);
        void this.registry.refreshCollateral(rows.map((r) => BigInt(r.agent_id)));
        for (const r of rows) this.emit(r.id);
        bus.publish({ type: "epoch.settled", at: now, epoch, transfers: this.transfers(epoch).map(transferView) });
        return;
      }
      // Did an earlier attempt go through after all (a lost response)? Trust the chain.
      const states = await Promise.all(rows.map((r) => this.chain.position(epoch, r.agent_id).catch(() => null)));
      const pending: SettlementRow[] = [];
      rows.forEach((r, i) => {
        const state = states[i]?.state;
        if (state === "Settled") {
          this.db.run("UPDATE settlements SET status = 'recorded', error = NULL, updated_at = ? WHERE id = ?", Date.now(), r.id);
          this.db.run("UPDATE positions SET state = 'settled' WHERE epoch = ? AND agent_id = ?", epoch, r.agent_id);
          this.db.run("UPDATE transfers SET status = 'settled' WHERE epoch = ? AND from_agent = ?", epoch, r.agent_id);
          this.emit(r.id);
        } else if (state === "Defaulted") {
          this.markDefaulted(r);
        } else pending.push(r);
      });
      if (pending.length > 1) {
        // one payload spoils the batch: send each on its own so the good ones settle
        this.sending.delete(epoch);
        for (const r of pending) await this.send(epoch, [r]);
        return;
      }
      for (const r of pending) {
        // the debtor signs again: more balance inside the verifier, a registered key, a fresh payload
        this.db.run(
          "UPDATE settlements SET status = 'awaiting_payment', intent_json = NULL, intent_hash = NULL, submitted_at = NULL, attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?",
          `transfer refused: ${failure ?? "unknown reason"}`,
          Date.now(),
          r.id,
        );
        log("warn", "settlement", `${r.id}: transfer refused (${failure}); the debtor will sign again`);
        this.emit(r.id);
      }
    } finally {
      this.sending.delete(epoch);
    }
  }

  private async default(row: SettlementRow): Promise<void> {
    if (this.defaulting.has(row.id)) return;
    this.defaulting.add(row.id);
    try {
      let hash: string | null = null;
      try {
        hash = (await this.chain.write(`declare_default e${row.epoch} #${row.agent_id}`, "declare_default", { epoch: row.epoch, agent_id: row.agent_id }, 300)).hash;
      } catch (err) {
        const pos = await this.chain.position(row.epoch, row.agent_id).catch(() => null);
        if (pos?.state !== "Defaulted") {
          log("warn", "settlement", `default of #${row.agent_id} in epoch ${row.epoch} failed: ${(err as Error).message}`);
          return;
        }
      }
      this.markDefaulted(row, hash);
    } finally {
      this.defaulting.delete(row.id);
    }
  }

  private markDefaulted(row: SettlementRow, hash: string | null = null): void {
    // counted once, by whichever call moves the row to defaulted
    const moved = this.db.run(
      "UPDATE settlements SET status = 'defaulted', settle_tx = COALESCE(?, settle_tx), error = 'missed the settlement deadline; covered from collateral', updated_at = ? WHERE id = ? AND status != 'defaulted'",
      hash,
      Date.now(),
      row.id,
    ).changes;
    if (!moved) return;
    this.db.run("UPDATE positions SET state = 'defaulted' WHERE epoch = ? AND agent_id = ?", row.epoch, row.agent_id);
    this.db.run("UPDATE transfers SET status = 'defaulted', tx = ? WHERE epoch = ? AND from_agent = ?", hash, row.epoch, row.agent_id);
    this.db.run("UPDATE epochs SET defaults = defaults + 1 WHERE id = ?", row.epoch);
    log("warn", "settlement", `agent #${row.agent_id} defaulted on epoch ${row.epoch}; ${row.amount} seized from collateral and paid to its creditors`);
    void this.registry.refreshCollateral([BigInt(row.agent_id)]);
    this.emit(row.id);
  }

  async seal(epochId: number): Promise<void> {
    let chainE = await this.chain.epoch(epochId);
    // right after the last settlement a lagging RPC node can still report the epoch as open
    for (let i = 0; chainE?.status !== "Sealed" && i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      chainE = await this.chain.epoch(epochId);
    }
    if (chainE?.status !== "Sealed") return;
    const receipt = chainE.receipt_hash;
    this.db.tx(() => {
      this.db.run("UPDATE epochs SET phase = 'sealed', onchain = 'settled', receipt_hash = ?, sealed_at = ?, error = NULL WHERE id = ?", receipt, Date.now(), epochId);
      this.db.run("UPDATE positions SET state = 'paid' WHERE epoch = ? AND state = 'creditor'", epochId);
      this.db.run(
        "UPDATE jobs SET status = 'settled' WHERE status = 'delivered' AND id IN (SELECT job_id FROM ious WHERE posted_epoch = ? AND status = 'netted')",
        epochId,
      );
    });
    const e = this.db.get<EpochRow>("SELECT * FROM epochs WHERE id = ?", epochId)!;
    bus.publish({ type: "epoch.phase", at: Date.now(), epoch: epochView(e) });
    log("info", "epochs", `epoch ${epochId} sealed; receipt ${receipt}`);
    void this.registry.refreshCollateral(this.registry.list().map((a) => a.agentId));
    this.onSealed(epochId);
  }

  private emit(id: string): void {
    const row = this.get(id);
    if (row) bus.publish({ type: "settlement.update", at: Date.now(), settlement: settlementView(row, this.chain.d) });
  }
}

export function settlementId(epoch: number, agentId: bigint): string {
  return `stl_${epoch}_${agentId}`;
}
