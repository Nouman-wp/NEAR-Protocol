import { formatUnits } from "@quorum/core";
import type { QuorumAgent } from "@quorum/sdk";
import type { Fleet, FleetMember } from "./fleet.ts";
import { STRATEGY_NOTES, seeded, strategy, type StrategyName } from "./strategies.ts";

/**
 * The group-buying market: buyer agents that each stand for one user pool their demand
 * for GPU hours and buy from competing seller agents in sealed-bid rounds.
 *
 * Everything here is scripted: demand, limits and bids come from a seeded random number
 * generator, and no model is called. The GPU hours are simulated too: the seller's
 * "delivery" is a signed lease receipt, not real compute, and it says so. What is real is
 * the market: every open, join, commit, reveal and close is a transaction from the
 * agent's own account, every purchase is a signed IOU, and every epoch settles.
 */

export const GPU_SERVICE = "gpu-hour";
/** the most any buyer pays per GPU hour: $0.05 */
const RESERVE = 50_000n;
const USD = (n: number) => BigInt(Math.round(n * 1e6));

const SELLERS: { name: string; strategy: StrategyName; cost: bigint }[] = [
  { name: "Atlas Compute", strategy: "cost-plus", cost: 24_000n },
  { name: "Borealis GPU", strategy: "undercutter", cost: 21_000n },
  { name: "Cinder Cloud", strategy: "adaptive", cost: 19_000n },
  { name: "Drift Render", strategy: "opportunist", cost: 30_000n },
  { name: "Ember Nodes", strategy: "noisy", cost: 22_000n },
  { name: "Fjord Compute", strategy: "adaptive", cost: 23_000n },
  { name: "Glacier GPU", strategy: "cost-plus", cost: 26_000n },
  { name: "Halo Render", strategy: "undercutter", cost: 25_000n },
];

export interface MarketRound {
  roundId: number;
  openedAt: number;
  opener: string;
  buyers: number;
  demand: number;
  status: "running" | "closed" | "void" | "failed";
  winner: string | null;
  clearingPrice: string | null;
  quantity: number;
  jobs: number;
  note: string;
}

export const buyerSlug = (i: number) => `buyer-${String(i + 1).padStart(2, "0")}`;
export const sellerSlug = (i: number) => `seller-${i + 1}`;

export function marketMembers(buyers: number, sellers: number, seed: number): FleetMember[] {
  const out: FleetMember[] = [];
  for (let i = 0; i < Math.min(sellers, SELLERS.length); i++) {
    const s = SELLERS[i]!;
    out.push({
      slug: sellerSlug(i),
      group: "market",
      profile: {
        name: s.name,
        role: "GPU seller",
        description: `Sells simulated GPU hours in sealed-bid rounds. Scripted strategy "${s.strategy}": ${STRATEGY_NOTES[s.strategy]}`,
        fleet: true,
        organization: "Quorum market simulation",
      },
      install: (fleet, agent) => installSeller(fleet, agent, s, seed + 101 * (i + 1)),
      buys: [],
    });
  }
  for (let i = 0; i < buyers; i++) {
    out.push({
      slug: buyerSlug(i),
      group: "market",
      profile: {
        name: `Buyer ${String(i + 1).padStart(2, "0")}`,
        role: "Buyer agent",
        description: "Stands for one user who needs GPU hours. Pools its demand with other buyers and pays only its share of the winning bid.",
        fleet: true,
        organization: "Quorum market simulation",
      },
      install: () => undefined,
      buys: [{ key: "main", goal: "[standing] Buy GPU hours in group-buy rounds", services: [GPU_SERVICE], budget: USD(200), perJobCap: USD(1), minRep: 0 }],
    });
  }
  return out;
}

function installSeller(fleet: Fleet, agent: QuorumAgent, s: (typeof SELLERS)[number], seed: number): void {
  let leases = 0;
  agent.sell<{ hours: number }, unknown>({
    id: GPU_SERVICE,
    name: "GPU hour (simulated)",
    description: "One hour of simulated GPU capacity. Sold through sealed-bid group-buy rounds; the listed price is this seller's cost-plus price.",
    price: (s.cost * 112n) / 100n,
    unit: "hour",
    tags: ["gpu", "compute", "simulation"],
    handler: async (input, ctx) => {
      fleet.touch(agent.profile!.slug);
      return {
        lease: `lease-${agent.agentId}-${++leases}`,
        hours: Number(input.hours ?? 1),
        round: ctx.spec.round ?? null,
        node: `sim-node-${1 + (leases % 4)}`,
        simulated: true,
        note: "Simulated capacity: no real GPU is leased. The market around it (bids, IOUs, settlement) is real.",
      };
    },
  });
  agent.bidOn(GPU_SERVICE, strategy(s.strategy, { cost: s.cost, history: () => fleet.priceHistory(GPU_SERVICE), rand: seeded(seed) }));
}

export class Market {
  readonly rounds: MarketRound[] = [];
  private readonly rand: () => number;
  private readonly fleet: Fleet;
  private running = 0;

  constructor(fleet: Fleet) {
    this.fleet = fleet;
    this.rand = seeded(fleet.cfg.simSeed);
  }

  get buyers(): QuorumAgent[] {
    return [...this.fleet.agents.entries()].filter(([slug]) => slug.startsWith("buyer-")).map(([, a]) => a);
  }

  get busy(): number {
    return this.running;
  }

  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rand() * xs.length)]!;
  }

  /**
   * One group buy, start to finish: a buyer opens the round, others join with their own
   * quantity and limit, sellers bid sealed, the contract picks the winner and the unit
   * price, and every buyer that accepted the price buys its share from the winner.
   */
  async runRound(): Promise<MarketRound> {
    const buyers = this.buyers;
    if (buyers.length < 2) throw new Error("the market needs at least two buyers");
    const opener = this.pick(buyers);
    const openerQty = 1 + Math.floor(this.rand() * 6);
    const want = Math.min(buyers.length - 1, 4 + Math.floor(this.rand() * 7));
    const joiners = buyers
      .filter((b) => b !== opener)
      .map((b) => ({ b, k: this.rand() }))
      .sort((x, y) => x.k - y.k)
      .slice(0, want)
      .map(({ b }) => ({ agent: b, quantity: 1 + Math.floor(this.rand() * 8), maxPrice: (RESERVE * BigInt(55 + Math.floor(this.rand() * 46))) / 100n }));
    const pricing = this.rand() < 0.75 ? ("SecondPrice" as const) : ("FirstPrice" as const);
    const rec: MarketRound = {
      roundId: 0,
      openedAt: Date.now(),
      opener: opener.profile!.name,
      buyers: 1,
      demand: openerQty,
      status: "running",
      winner: null,
      clearingPrice: null,
      quantity: 0,
      jobs: 0,
      note: "",
    };
    this.running++;
    try {
      const { roundId } = await opener.openRound({
        kind: "GroupBuy",
        service: GPU_SERVICE,
        spec: { service: GPU_SERVICE, title: "Pooled GPU hours", unit: "hour", opener: opener.agentId.toString(), openedAt: rec.openedAt, simulated: true },
        title: "Pooled GPU hours",
        quantity: openerQty,
        reservePrice: RESERVE,
        pricing,
        joinMs: this.fleet.cfg.joinMs,
        commitMs: this.fleet.cfg.commitMs,
        revealMs: this.fleet.cfg.revealMs,
      });
      rec.roundId = roundId;
      this.rounds.unshift(rec);
      if (this.rounds.length > 60) this.rounds.pop();
      this.fleet.touch(opener.profile!.slug);
      this.fleet.log("market", `round #${roundId}: ${opener.profile!.name} opens a group buy for ${openerQty} GPU hour(s), ${pricing === "SecondPrice" ? "second" : "first"} price, reserve ${formatUnits(RESERVE, 3)}`);

      const joined = await Promise.all(
        joiners.map((j) =>
          j.agent.joinRound(roundId, j.quantity, j.maxPrice).then(
            () => {
              this.fleet.touch(j.agent.profile!.slug);
              return j;
            },
            () => null, // the join window closed first
          ),
        ),
      );
      const inRound = joined.filter((j) => j !== null);
      rec.buyers = 1 + inRound.length;
      rec.demand = openerQty + inRound.reduce((n, j) => n + j.quantity, 0);
      void this.fleet.client.refreshRound(roundId).catch(() => undefined);

      const round = await opener.awaitRound(roundId);
      if (round.status !== "Closed" || round.winner === null) {
        rec.status = "void";
        rec.note = round.void_reason || "no winner";
        this.fleet.log("market", `round #${roundId} void: ${rec.note}`);
        return rec;
      }
      const price = BigInt(round.clearing_price);
      this.fleet.notePrice(GPU_SERVICE, price);
      rec.winner = (await this.fleet.agentSummary(String(round.winner)).catch(() => null))?.name ?? `#${round.winner}`;
      rec.clearingPrice = round.clearing_price;
      rec.quantity = round.total_quantity;
      this.fleet.log(
        "market",
        `round #${roundId} closed: ${rec.winner} wins ${round.total_quantity} hour(s) at ${formatUnits(price, 4)} each (${round.bids.length} sealed bid(s), ${round.allocations.length}/${rec.buyers} buyers accept the price)`,
      );

      // every allocated buyer buys exactly its share from the winner, as its own signed IOU
      const byId = new Map(buyers.map((b) => [b.agentId.toString(), b]));
      const results = await Promise.all(
        round.allocations.map(async (a) => {
          const buyer = byId.get(String(a.buyer));
          const intentId = buyer && this.fleet.standing.get(`${buyer.profile!.slug}:main`);
          if (!buyer || !intentId) return false;
          // a slow node can time a purchase out after the IOU went through: try again, and
          // count "already bought" as done
          for (let attempt = 0; ; attempt++) {
            try {
              await buyer.hireRoundWinner(round, { hours: a.quantity }, { intentId });
              return true;
            } catch (err) {
              const msg = (err as Error).message;
              if (/already bought its allocation/.test(msg)) return true;
              if (attempt >= 2) {
                this.fleet.log(buyer.profile!.slug, `could not buy its share of round #${roundId}: ${msg}`);
                return false;
              }
              await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
            }
          }
        }),
      );
      rec.jobs = results.filter(Boolean).length;
      rec.status = "closed";
      return rec;
    } catch (err) {
      rec.status = "failed";
      rec.note = (err as Error).message;
      this.fleet.log("market", `round ${rec.roundId ? `#${rec.roundId}` : "(not opened)"} failed: ${rec.note}`);
      return rec;
    } finally {
      this.running--;
    }
  }
}
