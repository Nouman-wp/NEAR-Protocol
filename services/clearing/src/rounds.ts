import { hashJson, type Hex, type IOU, type JobSpec, type RoundView } from "@quorum/core";
import type { Db } from "./db.ts";
import type { Chain, ChainRound } from "./chain.ts";
import { bus, log } from "./bus.ts";

interface RoundRow {
  id: number;
  kind: string;
  status: string;
  opener: number;
  service: string;
  title: string;
  spec_json: string | null;
  chain_json: string;
  winner: number | null;
  clearing_price: number | null;
  total_quantity: number;
  savings: number | null;
  opened_at: number;
  closed_at: number | null;
  open_tx: string | null;
  close_tx: string | null;
  updated_at: number;
}

interface Stored {
  round: ChainRound;
  /** sellers' on-chain scores when the round closed, to explain which bids counted */
  reputations: Record<string, number>;
}

/**
 * Sealed-bid rounds, mirrored from the coordinator contract. The contract runs every
 * round: agents open, join, commit, reveal and close from their own accounts, and the
 * winner and clearing price follow from the bids by a fixed rule. This book only reads
 * the chain, keeps a copy for the API and the live feed, and holds the ledger to the
 * result: a job that names a round must be bought from that round's winner at that
 * round's price.
 */
export class RoundBook {
  private syncing = false;
  private known = 0;

  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
  ) {
    this.known = this.db.get<{ m: number | null }>("SELECT MAX(id) AS m FROM rounds")?.m ?? 0;
  }

  /** Pull new rounds and refresh the ones still open. Cheap: one view call when nothing is happening. */
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const count = await this.chain.roundCount();
      const open = this.db.all<{ id: number }>("SELECT id FROM rounds WHERE status = 'Open'").map((r) => r.id);
      const fresh: number[] = [];
      for (let id = this.known + 1; id <= count; id++) fresh.push(id);
      // one round that cannot be read (a rate-limited RPC) must not hold up the others
      const results = await Promise.allSettled([...open, ...fresh].map((id) => this.refresh(id)));
      const freshFailed = results.slice(open.length).some((r) => r.status === "rejected");
      if (!freshFailed) this.known = Math.max(this.known, count);
      await this.closeAbandoned();
    } catch (err) {
      log("warn", "rounds", `sync failed: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  private closeTried = new Map<number, number>();

  /**
   * Anyone may close a round once its reveal window has passed. If the opener never did
   * (it crashed, or ran out of gas), the clearer closes it a minute later, so a round never
   * stays "open" for ever and its result, or its void, is on chain.
   */
  private async closeAbandoned(): Promise<void> {
    const now = Date.now();
    const rows = this.db.all<{ id: number; chain_json: string }>("SELECT id, chain_json FROM rounds WHERE status = 'Open'");
    for (const r of rows) {
      const reveal = (JSON.parse(r.chain_json) as Stored).round?.reveal_deadline ?? Infinity;
      if (now < reveal + 60_000 || now - (this.closeTried.get(r.id) ?? 0) < 5 * 60_000) continue;
      this.closeTried.set(r.id, now);
      try {
        await this.chain.write(`close_round r${r.id}`, "close_round", { round_id: r.id }, 25);
        log("info", "rounds", `round #${r.id} was left open by its opener; closed it`);
        await this.refresh(r.id);
      } catch (err) {
        if (!/round is closed/.test((err as Error).message)) log("warn", "rounds", `could not close round #${r.id}: ${(err as Error).message}`);
        await this.refresh(r.id).catch(() => undefined);
      }
      return; // one per sync: the clearer's transactions stay in order
    }
  }

  private refreshing = new Map<number, Promise<RoundView | undefined>>();

  /** Read one round from the chain. Concurrent calls for the same round share one read. */
  refresh(id: number): Promise<RoundView | undefined> {
    const inflight = this.refreshing.get(id);
    if (inflight) return inflight;
    const p = this.refreshNow(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, p);
    return p;
  }

  private async refreshNow(id: number): Promise<RoundView | undefined> {
    const round = await this.chain.round(id);
    if (!round) return undefined;
    const prev = this.row(id);
    const before = prev ? (JSON.parse(prev.chain_json) as Stored) : null;
    let reputations = before?.reputations ?? {};
    if (round.status !== "Open" && Object.keys(reputations).length === 0 && round.bids.length) {
      const scores = await Promise.all(round.bids.map((b) => this.chain.reputationOf(b.seller).catch(() => 1000)));
      reputations = Object.fromEntries(round.bids.map((b, i) => [String(b.seller), scores[i]!]));
    }
    const stored: Stored = { round, reputations };
    const json = JSON.stringify(stored);
    if (prev && prev.chain_json === json) return this.view(prev);
    const closed = round.status === "Closed";
    const savings = closed ? (BigInt(round.reserve_price) - BigInt(round.clearing_price)) * BigInt(round.total_quantity) : null;
    const now = Date.now();
    this.db.run(
      `INSERT INTO rounds(id, kind, status, opener, service, chain_json, winner, clearing_price, total_quantity, savings, opened_at, closed_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, chain_json = excluded.chain_json, winner = excluded.winner, clearing_price = excluded.clearing_price,
         total_quantity = excluded.total_quantity, savings = excluded.savings, closed_at = excluded.closed_at, updated_at = excluded.updated_at`,
      id,
      round.kind,
      round.status,
      round.opener,
      round.service,
      json,
      round.winner,
      closed ? Number(round.clearing_price) : null,
      round.total_quantity,
      savings === null ? null : Number(savings),
      round.opened_at,
      round.closed_at || null,
      now,
    );
    const view = this.view(this.row(id)!);
    bus.publish({ type: "round", at: now, round: view });
    if (!prev) log("info", "rounds", `round #${id} opened by #${round.opener}: ${round.kind} for ${round.service}, reserve ${round.reserve_price}`);
    if (prev?.status === "Open" && round.status !== "Open") {
      log(
        "info",
        "rounds",
        closed
          ? `round #${id} closed: #${round.winner} wins at ${round.clearing_price} per unit, ${round.total_quantity} unit(s), ${round.bids.length} bid(s)`
          : `round #${id} void: ${round.void_reason}`,
      );
    }
    return view;
  }

  /**
   * Attach the job specification a round was opened for. Anyone may post it: it is kept
   * only if it hashes to the `spec_hash` the opener committed to on chain.
   */
  async describe(id: number, spec: unknown, title?: string): Promise<RoundView> {
    const view = this.get(id) ?? (await this.refresh(id));
    if (!view) throw new Error("unknown round");
    if (hashJson(spec) !== view.specHash) throw new Error("the specification does not hash to the round's spec_hash");
    const t = String(title ?? (spec as { title?: unknown })?.title ?? "").slice(0, 140);
    this.db.run("UPDATE rounds SET spec_json = ?, title = ?, updated_at = ? WHERE id = ?", JSON.stringify(spec), t, Date.now(), id);
    const next = this.get(id)!;
    bus.publish({ type: "round", at: Date.now(), round: next });
    return next;
  }

  /** Record the transaction that opened or closed a round, once the chain confirms it called the coordinator. */
  async noteTx(id: number, kind: "open" | "close", hash: string, sender: string): Promise<void> {
    if (!this.row(id) && !(await this.refresh(id))) throw new Error("unknown round");
    const raw = (await this.chain.rpc.txStatus(hash, sender)) as { transaction?: { receiver_id?: string } } | null;
    if (raw?.transaction?.receiver_id !== this.chain.d.contract) throw new Error("that transaction did not call the coordinator contract");
    this.db.run(`UPDATE rounds SET ${kind === "open" ? "open_tx" : "close_tx"} = ?, updated_at = ? WHERE id = ?`, hash, Date.now(), id);
    bus.publish({ type: "round", at: Date.now(), round: this.get(id)! });
  }

  /**
   * The ledger's rule for a job priced by a round. Returns the reason to refuse, or null.
   * A round binds exactly one job per allocated buyer, with the round's winner, at
   * quantity x clearing price.
   */
  check(spec: JobSpec, iou: IOU): string | null {
    if (!spec.round) return null;
    const row = this.row(Number(spec.round));
    if (!row) return `round #${spec.round} is not known yet`;
    const { round } = JSON.parse(row.chain_json) as Stored;
    if (round.status !== "Closed") return `round #${round.id} is ${round.status === "Open" ? "still open" : "void"}`;
    if (spec.service !== round.service) return `round #${round.id} was for ${round.service}, not ${spec.service}`;
    if (BigInt(round.winner ?? 0) !== iou.seller) return `round #${round.id} was won by agent #${round.winner}, not #${iou.seller}`;
    const allocation = round.allocations.find((a) => BigInt(a.buyer) === iou.buyer);
    if (!allocation) return `agent #${iou.buyer} has no allocation in round #${round.id}`;
    if (BigInt(allocation.cost) !== iou.amount) return `round #${round.id} set this buyer's cost at ${allocation.cost}; the IOU is for ${iou.amount}`;
    const used = this.db.get("SELECT 1 FROM jobs WHERE round_id = ? AND buyer = ? AND status != 'voided'", round.id, Number(iou.buyer));
    if (used) return `agent #${iou.buyer} already bought its allocation of round #${round.id}`;
    return null;
  }

  get(id: number): RoundView | undefined {
    const r = this.row(id);
    return r ? this.view(r) : undefined;
  }

  list(filter: { status?: string; kind?: string; agent?: string; limit?: number; before?: number }): RoundView[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.before) {
      where.push("id < ?");
      params.push(filter.before);
    }
    let rows = this.db.all<RoundRow>(`SELECT * FROM rounds ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...params, filter.agent ? 500 : (filter.limit ?? 50));
    if (filter.agent) {
      const a = Number(filter.agent);
      rows = rows
        .filter((r) => {
          const { round } = JSON.parse(r.chain_json) as Stored;
          return round.opener === a || round.winner === a || round.demand.some((d) => d.buyer === a) || round.bids.some((b) => b.seller === a);
        })
        .slice(0, filter.limit ?? 50);
    }
    return rows.map((r) => this.view(r));
  }

  /** Clearing prices of closed rounds for a service, oldest first: the price discovery chart. */
  priceHistory(service: string, limit = 200): { round: number; at: number; price: string; reserve: string; quantity: number; bids: number; kind: string }[] {
    return this.db
      .all<RoundRow>("SELECT * FROM rounds WHERE service = ? AND status = 'Closed' ORDER BY id DESC LIMIT ?", service, limit)
      .reverse()
      .map((r) => {
        const { round } = JSON.parse(r.chain_json) as Stored;
        return { round: r.id, at: r.closed_at ?? r.opened_at, price: round.clearing_price, reserve: round.reserve_price, quantity: round.total_quantity, bids: round.bids.length, kind: r.kind };
      });
  }

  stats(): { closed: number; void: number; open: number; savings: string } {
    const s = this.db.get<{ closed: number | null; voided: number | null; open: number | null; savings: number | null }>(
      "SELECT SUM(status = 'Closed') AS closed, SUM(status = 'Void') AS voided, SUM(status = 'Open') AS open, SUM(savings) AS savings FROM rounds",
    )!;
    return { closed: s.closed ?? 0, void: s.voided ?? 0, open: s.open ?? 0, savings: String(s.savings ?? 0) };
  }

  private row(id: number): RoundRow | undefined {
    return this.db.get<RoundRow>("SELECT * FROM rounds WHERE id = ?", id);
  }

  private view(r: RoundRow): RoundView {
    const { round, reputations } = JSON.parse(r.chain_json) as Stored;
    const now = Date.now();
    const phase: RoundView["phase"] =
      round.status === "Closed"
        ? "closed"
        : round.status === "Void"
          ? "void"
          : now < round.join_deadline
            ? "joining"
            : now < round.commit_deadline
              ? "committing"
              : now < round.reveal_deadline
                ? "revealing"
                : "closing";
    const jobs = new Map(this.db.all<{ buyer: number; id: string }>("SELECT buyer, id FROM jobs WHERE round_id = ? AND status != 'voided'", r.id).map((j) => [j.buyer, j.id]));
    const settled = round.status !== "Open";
    return {
      id: r.id,
      kind: round.kind,
      pricing: round.pricing,
      status: round.status,
      phase,
      opener: String(round.opener),
      service: round.service,
      title: r.title,
      spec: r.spec_json ? JSON.parse(r.spec_json) : null,
      specHash: round.spec_hash as Hex,
      reservePrice: round.reserve_price,
      minReputation: round.min_reputation,
      openedAt: round.opened_at,
      joinDeadline: round.join_deadline,
      commitDeadline: round.commit_deadline,
      revealDeadline: round.reveal_deadline,
      closedAt: round.closed_at || null,
      demand: round.demand.map((d) => ({ buyer: String(d.buyer), quantity: d.quantity, maxPrice: d.max_price })),
      bids: round.bids.map((b) => {
        let invalid: string | null = null;
        if (settled) {
          if (b.price === null) invalid = "never revealed";
          else if (BigInt(b.price) > BigInt(round.reserve_price)) invalid = "above the reserve price";
          else if ((reputations[String(b.seller)] ?? 1000) < round.min_reputation) invalid = "below the reputation floor";
        }
        return { seller: String(b.seller), commitment: b.commitment, committedAt: b.committed_at, price: b.price, revealedAt: b.revealed_at || null, invalid };
      }),
      winner: round.winner === null ? null : String(round.winner),
      clearingPrice: round.status === "Closed" ? round.clearing_price : null,
      totalQuantity: round.total_quantity,
      allocations: round.allocations.map((a) => ({ buyer: String(a.buyer), quantity: a.quantity, cost: a.cost, jobId: jobs.get(a.buyer) ?? null })),
      voidReason: round.void_reason || null,
      savings: r.savings === null ? null : String(r.savings),
      openTx: r.open_tx,
      closeTx: r.close_tx,
    };
  }
}
