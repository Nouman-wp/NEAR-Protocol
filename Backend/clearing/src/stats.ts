import type { HeadlineStats } from "@yuki/core";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { EpochEngine } from "./epochs.ts";
import type { Registry } from "./registry.ts";
import type { RoundBook } from "./rounds.ts";

/** Headline numbers. Only sealed (fully settled) epochs count towards cleared totals. */
export function headlineStats(db: Db, chain: Chain, epochs: EpochEngine, registry: Registry, rounds: RoundBook, intentsHealthy: boolean): HeadlineStats {
  const sealed = db.get<{ n: number; ious: number | null; gross: number | null; net: number | null; transfers: number | null }>(
    "SELECT COUNT(*) AS n, SUM(iou_count) AS ious, SUM(gross) AS gross, SUM(net) AS net, SUM(transfers) AS transfers FROM epochs WHERE phase = 'sealed'",
  )!;
  const moved = db.get<{ n: number; v: number | null }>("SELECT COUNT(*) AS n, SUM(amount) AS v FROM transfers WHERE status = 'settled'")!;
  const jobs = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'settled'")!;
  const ious = sealed.ious ?? 0;
  const avoided = Math.max(0, ious - (sealed.transfers ?? 0));
  const cur = epochs.current();
  const real = chain.d.intentsKind === "near-intents";
  return {
    agents: registry.list().filter((a) => a.status !== "retired").length,
    jobsCleared: jobs.n,
    iousCleared: ious,
    epochsSealed: sealed.n,
    grossVolume: String(sealed.gross ?? 0),
    netVolume: String(sealed.net ?? 0),
    valueSettled: String(moved.v ?? 0),
    intentTransfers: moved.n,
    roundsClosed: rounds.stats().closed,
    transfersAvoided: avoided,
    transferReduction: ious === 0 ? 0 : avoided / ious,
    currentEpoch: cur.id,
    epochPhase: "intake",
    phaseEndsAt: cur.intake_ends_at,
    network: { key: chain.key, name: chain.networkName, explorer: chain.explorer },
    intents: {
      account: chain.d.intents,
      kind: chain.d.intentsKind,
      healthy: intentsHealthy,
      note: real ? "NEAR Intents verifier" : "intents-lite: a stand-in for intents.near, which exists on mainnet only",
    },
    deployment: {
      root: chain.d.root,
      contract: chain.d.contract,
      token: chain.d.token,
      intents: chain.d.intents,
      clearer: chain.d.clearer,
      mockToken: String(chain.d.mockToken),
    },
  };
}
