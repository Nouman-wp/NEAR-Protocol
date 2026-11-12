import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LOCAL_DEV_SEED, NETWORKS, accountKey, keyPairFromSecret, type Deployment, type NetworkKey } from "@quorum/core";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

/** The env file in use: QUORUM_ENV_FILE (e.g. .env.testnet) or .env. */
export function envFile(): string {
  return resolve(REPO_ROOT, process.env.QUORUM_ENV_FILE ?? ".env");
}

/** Minimal .env loader so the service runs with plain `pnpm clearing`. Real env wins. */
export function loadDotEnv(file = envFile()): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}

const schema = z.object({
  QUORUM_NETWORK: z.enum(["local", "testnet", "mainnet"]).default("local"),
  NEAR_RPC_URL: z.string().optional(),
  /** master seed every account key is derived from; optional on a local sandbox */
  QUORUM_SEED: z.string().min(16).optional(),
  /** overrides the derived key of the clearer account */
  CLEARER_SECRET_KEY: z.string().optional(),
  PORT: z.coerce.number().default(8787),
  PUBLIC_API_URL: z.string().default("http://localhost:8787"),
  DATA_DIR: z.string().default(resolve(REPO_ROOT, ".data")),
  EPOCH_INTAKE_SECONDS: z.coerce.number().min(10).default(75),
  DISPUTE_WINDOW_SECONDS: z.coerce.number().min(3).default(12),
  EPOCH_CHALLENGE_SECONDS: z.coerce.number().min(5).default(18),
  ARBITRATION_TIMEOUT_SECONDS: z.coerce.number().min(3).default(15),
  /** IOUs per post_ious call: about 0.7 Tgas each, against NEAR's 300 Tgas limit per call */
  POST_CHUNK_SIZE: z.coerce.number().min(1).max(200).default(120),
  /** debtors' signed transfers per settle call */
  SETTLE_CHUNK_SIZE: z.coerce.number().min(1).max(40).default(12),
  /** how long the service waits for more debtors before it sends a partial batch */
  SETTLE_GATHER_SECONDS: z.coerce.number().min(0).default(6),
  WRITE_REPUTATION_ONCHAIN: z.enum(["true", "false"]).default("true"),
  /** keep this many sealed epochs and closed rounds in contract state; older ones are pruned
   *  to give their storage back (0 = never prune; default: 0 locally, 20/40 elsewhere) */
  PRUNE_KEEP_EPOCHS: z.coerce.number().min(0).optional(),
  PRUNE_KEEP_ROUNDS: z.coerce.number().min(0).optional(),
  REPUTATION_EPOCH_STRIDE: z.coerce.number().min(1).default(1),
  /** quiet epochs stay open until the first IOU arrives, so an idle service sends no transactions */
  EPOCH_EXTEND_IDLE: z.enum(["true", "false"]).optional(),
  /** where the swarm listens; defaults to localhost on FLEET_PORT (8788) */
  FLEET_CONTROL_URL: z.string().optional(),
  FLEET_PORT: z.coerce.number().default(8788),
  /** the fleet's public base; cards under it are fetched from FLEET_CONTROL_URL directly */
  PUBLIC_FLEET_URL: z.string().optional(),
  ADMIN_TOKEN: z.string().min(8).default("quorum-admin"),
  CORS_ORIGIN: z.string().default("*"),
  /** optional Supabase mirror of this database: project URL and its secret key (server side only) */
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
});

export type Config = z.infer<typeof schema> & {
  FLEET_CONTROL_URL: string;
  /** sessions issued at sign-in are MACed with a secret derived from this */
  sessionSeed: string;
  network: NetworkKey;
  keepEpochs: number;
  keepRounds: number;
  rpcUrl: string;
  deployment: Deployment;
  clearerSecretKey: string;
  extendIdleEpochs: boolean;
};

export function loadConfig(): Config {
  loadDotEnv();
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid clearing service configuration:\n${issues}`);
  }
  const env = parsed.data;
  const network = env.QUORUM_NETWORK as NetworkKey;
  const deployment = loadDeployment(network);
  const seed = env.QUORUM_SEED ?? (network === "local" ? LOCAL_DEV_SEED : undefined);
  const clearerSecretKey = env.CLEARER_SECRET_KEY ?? (seed ? accountKey(seed, "clearer").secretKey : undefined);
  if (!clearerSecretKey) throw new Error("Set QUORUM_SEED (or CLEARER_SECRET_KEY): the clearing service signs as the clearer account");
  const have = keyPairFromSecret(clearerSecretKey).publicKey;
  if (have !== deployment.clearerKey) {
    throw new Error(`The clearer key in this environment (${have}) is not the one ${deployment.clearer} was created with (${deployment.clearerKey}). Check QUORUM_SEED.`);
  }
  return {
    ...env,
    sessionSeed: seed ?? env.ADMIN_TOKEN ?? "quorum-local",
    FLEET_CONTROL_URL: (env.FLEET_CONTROL_URL ?? `http://localhost:${env.FLEET_PORT}`).replace(/\/+$/, ""),
    network,
    rpcUrl: env.NEAR_RPC_URL || NETWORKS[network].rpcUrl,
    deployment,
    clearerSecretKey,
    extendIdleEpochs: env.EPOCH_EXTEND_IDLE ? env.EPOCH_EXTEND_IDLE === "true" : network !== "local",
    keepEpochs: env.PRUNE_KEEP_EPOCHS ?? (network === "local" ? 0 : 20),
    keepRounds: env.PRUNE_KEEP_ROUNDS ?? (network === "local" ? 0 : 40),
  };
}

/** This deployment's ledger: names its SQLite file and tags its rows in the Supabase mirror. */
export function ledgerName(cfg: Pick<Config, "network" | "deployment">): string {
  return `quorum-${cfg.network}-${cfg.deployment.contract.replace(/[^a-z0-9]+/g, "-")}-${cfg.deployment.deployedAt.toString(36)}`;
}

export function deploymentPath(network: NetworkKey): string {
  return resolve(REPO_ROOT, "deployments", `${network}.json`);
}

export function loadDeployment(network: NetworkKey): Deployment {
  const file = deploymentPath(network);
  if (!existsSync(file)) {
    throw new Error(`No deployment for ${network} at ${file}. Run \`pnpm deploy:${network}\` first.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Deployment;
}
