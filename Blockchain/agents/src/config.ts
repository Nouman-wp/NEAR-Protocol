import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_DEV_SEED, ONE_NEAR, accountKey, type KeyPair } from "@quorum/core";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

function loadDotEnv(): void {
  const file = resolve(REPO_ROOT, process.env.QUORUM_ENV_FILE ?? ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

export interface FleetConfig {
  network: string;
  port: number;
  publicUrl: string;
  clearingUrl: string;
  rpcUrl?: string;
  /** master seed: every agent's key follows from it and the agent's name */
  seed: string;
  /** secret key of the root account, which creates the agents' sub-accounts and signs their intents */
  rootSecretKey: string;
  adminToken: string;
  /** which swarms run: the research fleet, the group-buy market, the studios */
  research: boolean;
  market: boolean;
  studios: boolean;
  /** where delivered files (images, video, captions) are stored */
  dataDir: string;
  background: boolean;
  backgroundIntervalSeconds: number;
  collateralTarget: bigint;
  orchestratorCollateral: bigint;
  /** balance each agent keeps inside the NEAR Intents verifier to pay its net debts from */
  intentsTarget: bigint;
  /** yoctoNEAR each agent's account keeps for gas and storage */
  nearTarget: bigint;
  rogueBadRate: number;
  guestSessionsPerHour: number;
  webUrl: string;
  /** sealed-bid round windows, in milliseconds */
  joinMs: number;
  commitMs: number;
  revealMs: number;
  /** the group-buy market: how many scripted buyers and sellers, and how often a round opens */
  simBuyers: number;
  simSellers: number;
  simIntervalSeconds: number;
  simSeed: number;
  /** open group-buy rounds on a timer; off means only when a scenario asks */
  simAuto: boolean;
}

export function loadFleetConfig(): FleetConfig {
  loadDotEnv();
  const e = process.env;
  const network = e.QUORUM_NETWORK ?? "local";
  const local = network === "local";
  const seed = e.QUORUM_SEED ?? (local ? LOCAL_DEV_SEED : "");
  if (!seed) throw new Error(`QUORUM_SEED must be set on ${network}`);
  const rootSecretKey = e.QUORUM_ROOT_KEY ?? (local ? accountKey(seed, "root").secretKey : "");
  if (!rootSecretKey) throw new Error(`QUORUM_ROOT_KEY must be set on ${network}`);
  const units = (v: string | undefined, d: string) => BigInt(Math.round(Number(v ?? d) * 1e6));
  const ms = (v: string | undefined, d: number) => Math.round(Number(v ?? d) * 1000);
  const modes = (e.FLEET_MODE ?? "research,market,studios").split(",").map((s) => s.trim());
  return {
    network,
    port: Number(e.FLEET_PORT ?? 8788),
    publicUrl: (e.PUBLIC_FLEET_URL ?? "http://localhost:8788").replace(/\/+$/, ""),
    clearingUrl: (e.CLEARING_URL ?? `http://localhost:${e.PORT ?? 8787}`).replace(/\/+$/, ""),
    rpcUrl: e.NEAR_RPC_URL || undefined,
    seed,
    rootSecretKey,
    adminToken: e.ADMIN_TOKEN ?? "quorum-admin",
    research: modes.includes("research"),
    market: modes.includes("market"),
    studios: modes.includes("studios"),
    dataDir: e.DATA_DIR ?? resolve(REPO_ROOT, ".data"),
    // on a public network every round and settlement costs storage: traffic is on demand by default
    background: (e.FLEET_BACKGROUND ?? (local ? "on" : "off")) !== "off",
    backgroundIntervalSeconds: Number(e.BACKGROUND_INTERVAL_SECONDS ?? 45),
    collateralTarget: units(e.COLLATERAL_TARGET, local ? "25" : "10"),
    orchestratorCollateral: units(e.ORCHESTRATOR_COLLATERAL, local ? "100" : "20"),
    intentsTarget: units(e.INTENTS_TARGET, local ? "40" : "15"),
    nearTarget: (BigInt(Math.round(Number(e.NEAR_TARGET ?? (local ? "2" : "0.06")) * 1e6)) * ONE_NEAR) / 1_000_000n,
    rogueBadRate: Number(e.ROGUE_BAD_RATE ?? 0.5),
    guestSessionsPerHour: Number(e.GUEST_SESSIONS_PER_HOUR ?? 20),
    webUrl: (e.PUBLIC_WEB_URL ?? e.PUBLIC_FLEET_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    joinMs: ms(e.ROUND_JOIN_SECONDS, local ? 5 : 12),
    commitMs: ms(e.ROUND_COMMIT_SECONDS, local ? 6 : 14),
    revealMs: ms(e.ROUND_REVEAL_SECONDS, local ? 6 : 14),
    simBuyers: Number(e.SIM_BUYERS ?? 20),
    simSellers: Number(e.SIM_SELLERS ?? 5),
    simIntervalSeconds: Number(e.SIM_INTERVAL_SECONDS ?? (local ? 30 : 75)),
    simSeed: Number(e.SIM_SEED ?? 42),
    simAuto: (e.SIM_AUTO ?? "on") !== "off",
  };
}

/** Deterministic per-agent keys: the agent `scout` is the account `scout.<root>` with this key. */
export function agentKey(seed: string, slug: string): KeyPair {
  return accountKey(seed, slug);
}
