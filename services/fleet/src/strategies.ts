import type { RoundView } from "@quorum/core";
import type { BidStrategy } from "@quorum/sdk";

/**
 * Scripted bidding strategies. No model is called anywhere: a bid is a few lines of
 * arithmetic over the seller's cost, the round's reserve price and past clearing prices,
 * with a seeded random number where a strategy wants noise. Same seed, same bids.
 */

export type StrategyName = "cost-plus" | "undercutter" | "adaptive" | "opportunist" | "noisy";

export interface StrategyContext {
  /** what one unit costs this seller to deliver, in base units */
  cost: bigint;
  /** clearing prices of earlier rounds for the same service, oldest first */
  history: () => bigint[];
  rand: () => number;
}

/** Small deterministic generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (v: bigint, percent: number) => (v * BigInt(Math.round(percent * 100))) / 10_000n;
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export const STRATEGY_NOTES: Record<StrategyName, string> = {
  "cost-plus": "Always bids its cost plus a fixed 12% margin.",
  undercutter: "Bids 6% under the last clearing price, never below cost plus 2%.",
  adaptive: "Tracks the average of the last five clearing prices and bids 3% under it, never below cost plus 8%.",
  opportunist: "Bids just under the reserve price and only wins when nobody else shows up.",
  noisy: "Bids its cost plus a random margin between 5% and 45%.",
};

export function strategy(name: StrategyName, ctx: StrategyContext): BidStrategy {
  return (round: RoundView) => {
    const reserve = BigInt(round.reservePrice);
    const past = ctx.history();
    let bid: bigint;
    switch (name) {
      case "cost-plus":
        bid = pct(ctx.cost, 112);
        break;
      case "undercutter": {
        const last = past[past.length - 1];
        bid = max(last === undefined ? pct(reserve, 80) : pct(last, 94), pct(ctx.cost, 102));
        break;
      }
      case "adaptive": {
        const recent = past.slice(-5);
        const mean = recent.length ? recent.reduce((a, b) => a + b, 0n) / BigInt(recent.length) : (ctx.cost + reserve) / 2n;
        bid = max(pct(mean, 97), pct(ctx.cost, 108));
        break;
      }
      case "opportunist":
        bid = max(pct(reserve, 96), ctx.cost);
        break;
      case "noisy":
        bid = pct(ctx.cost, 105 + ctx.rand() * 40);
        break;
    }
    // a seller never bids below cost, and a bid above the reserve cannot win: sit the round out
    if (bid < ctx.cost) bid = ctx.cost;
    return bid > reserve ? null : bid;
  };
}
