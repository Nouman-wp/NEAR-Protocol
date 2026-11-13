import type { QuorumDomain } from "@quorum/core";
import { ledgerName, loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Chain } from "./chain.ts";
import { Registry } from "./registry.ts";
import { ReputationBook } from "./reputation.ts";
import { Intents } from "./intents.ts";
import { Ledger } from "./ledger.ts";
import { EpochEngine } from "./epochs.ts";
import { Settlements } from "./settlements.ts";
import { RoundBook } from "./rounds.ts";
import { buildApi } from "./api.ts";
import { removeMirror, SupabaseMirror } from "./mirror.ts";
import { bus, log } from "./bus.ts";
import { headlineStats } from "./stats.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = new Chain(cfg.network, cfg.rpcUrl, cfg.clearerSecretKey, cfg.deployment);
  if (!(await chain.ping())) throw new Error(`cannot reach the ${cfg.network} RPC at ${cfg.rpcUrl}: ${chain.lastError}`);
  const onchain = await chain.config();
  if (onchain.clearer !== cfg.deployment.clearer || onchain.token !== cfg.deployment.token || onchain.intents !== cfg.deployment.intents) {
    throw new Error(`Blockchain/deployments/${cfg.network}.json does not describe the contract at ${cfg.deployment.contract}. Run the deploy script again.`);
  }

  // one database per deployment, so a redeploy never mixes ledgers
  const db = new Db(cfg.DATA_DIR, `${ledgerName(cfg)}.sqlite`);
  const domain: QuorumDomain = { network: cfg.network, contract: cfg.deployment.contract };

  const registry = new Registry(db, chain);
  if (cfg.PUBLIC_FLEET_URL && cfg.PUBLIC_FLEET_URL !== cfg.FLEET_CONTROL_URL) {
    registry.routes = [[`${cfg.PUBLIC_FLEET_URL.replace(/\/+$/, "")}/`, `${cfg.FLEET_CONTROL_URL.replace(/\/+$/, "")}/`]];
  }
  await registry.sync(true);
  const rep = new ReputationBook(db);
  const intents = new Intents(db, registry, domain, chain);
  const rounds = new RoundBook(db, chain);
  await rounds.sync();

  // is the verifier there and does it answer the way execute_intents callers need?
  const checkVerifier = () => chain.intentsBalance(cfg.deployment.clearer).then(() => true, () => false);
  let intentsHealthy = await checkVerifier();

  // eslint-disable-next-line prefer-const
  let epochs: EpochEngine;
  const settlements = new Settlements(db, chain, registry, { chunkSize: cfg.SETTLE_CHUNK_SIZE, gatherMs: cfg.SETTLE_GATHER_SECONDS * 1000 }, () => void epochs.flushReputation());
  epochs = new EpochEngine(db, chain, registry, rep, intents, settlements, {
    intakeSeconds: cfg.EPOCH_INTAKE_SECONDS,
    challengeSeconds: cfg.EPOCH_CHALLENGE_SECONDS,
    arbitrationTimeoutSeconds: cfg.ARBITRATION_TIMEOUT_SECONDS,
    jobGraceSeconds: cfg.JOB_GRACE_SECONDS,
    postChunkSize: cfg.POST_CHUNK_SIZE,
    writeReputation: cfg.WRITE_REPUTATION_ONCHAIN === "true",
    reputationStride: cfg.REPUTATION_EPOCH_STRIDE,
    publicUrl: cfg.PUBLIC_API_URL,
    extendIdle: cfg.extendIdleEpochs,
  });
  const ledger = new Ledger(db, registry, intents, rep, chain, domain, cfg.deployment.token, { disputeWindowSeconds: cfg.DISPUTE_WINDOW_SECONDS, publicUrl: cfg.PUBLIC_API_URL }, () =>
    epochs.intake(),
  );
  ledger.roundCheck = (spec, iou) => rounds.check(spec, iou);
  await epochs.start();

  // off-server copy of the ledger in Supabase, when configured
  let mirror: SupabaseMirror | undefined;
  if (cfg.SUPABASE_URL && cfg.SUPABASE_SECRET_KEY) {
    mirror = new SupabaseMirror(db, { url: cfg.SUPABASE_URL, key: cfg.SUPABASE_SECRET_KEY, deployment: ledgerName(cfg) });
    mirror.start();
  } else removeMirror(db);

  const app = await buildApi({ cfg, db, chain, registry, rep, intents, ledger, epochs, settlements, rounds, mirror, domain, intentsHealthy: () => intentsHealthy });
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });

  setInterval(() => void registry.sync(), cfg.network === "local" ? 5_000 : 10_000);
  // re-read every agent card now and then, so new or repriced services show up without a restart
  setTimeout(() => void registry.sync(true), 60_000);
  setInterval(() => void registry.sync(true), 10 * 60_000);
  setInterval(() => void rounds.sync(), cfg.network === "local" ? 1_000 : 3_000);
  setInterval(() => void settlements.tick().catch((err) => log("warn", "settlement", (err as Error).message)), 2_000);
  setInterval(() => void chain.ping(), 10_000);
  if (cfg.keepEpochs > 0 || cfg.keepRounds > 0) setInterval(() => void prune(), 5 * 60_000);
  setInterval(async () => {
    intentsHealthy = await checkVerifier();
  }, 15_000);
  setInterval(() => {
    try {
      bus.publish({ type: "stats", at: Date.now(), stats: headlineStats(db, chain, epochs, registry, rounds, intentsHealthy) });
    } catch {
      // stats are best effort
    }
  }, 2_000);

  /** Give the storage of old sealed epochs and closed rounds back. The ledger keeps them all. */
  async function prune(): Promise<void> {
    try {
      const done = Number(db.getMeta("pruned_epoch") ?? "0");
      const doneRound = Number(db.getMeta("pruned_round") ?? "0");
      const epochIds = cfg.keepEpochs
        ? db.all<{ id: number }>("SELECT id FROM epochs WHERE phase = 'sealed' AND id > ? AND id <= (SELECT MAX(id) FROM epochs) - ? ORDER BY id LIMIT 20", done, cfg.keepEpochs).map((r) => r.id)
        : [];
      const roundIds = cfg.keepRounds
        ? db.all<{ id: number }>("SELECT id FROM rounds WHERE status != 'Open' AND id > ? AND id <= (SELECT MAX(id) FROM rounds) - ? ORDER BY id LIMIT 20", doneRound, cfg.keepRounds).map((r) => r.id)
        : [];
      if (!epochIds.length && !roundIds.length) return;
      await chain.write(`prune ${epochIds.length} epochs, ${roundIds.length} rounds`, "prune", { epochs: epochIds, rounds: roundIds });
      if (epochIds.length) db.setMeta("pruned_epoch", String(epochIds[epochIds.length - 1]));
      if (roundIds.length) db.setMeta("pruned_round", String(roundIds[roundIds.length - 1]));
    } catch (err) {
      log("warn", "chain", `pruning failed, will retry: ${(err as Error).message}`);
    }
  }

  log(
    "info",
    "clearing",
    `Quorum clearing service on :${cfg.PORT} | ${chain.networkName} | coordinator ${cfg.deployment.contract} | verifier ${cfg.deployment.intents} (${cfg.deployment.intentsKind})${intentsHealthy ? "" : " (unreachable)"} | mirror ${mirror ? cfg.SUPABASE_URL : "off"}`,
  );

  const shutdown = async () => {
    epochs.stop();
    mirror?.stop();
    await mirror?.flush();
    await app.close();
    db.raw.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
