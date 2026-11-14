// Network, key and deployment helpers shared by the deploy, dev and simulation scripts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_DEV_SEED, NETWORKS, NearAccount, NearRpc, accountKey, type Deployment, type KeyPair, type NetworkKey } from "@yuki/core";
import { ROOT, loadEnv } from "./lib.mjs";

/** The account and key every near-sandbox node starts with. Public, local only. */
export const SANDBOX_ROOT = {
  accountId: "sandbox",
  secretKey: "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
};
/** The seed local keys are derived from. Public, local only. */
export const LOCAL_SEED = LOCAL_DEV_SEED;

export interface Net {
  key: NetworkKey;
  rpcUrl: string;
  rpc: NearRpc;
  /** parent account of the contracts and of every agent */
  root: string;
  seed: string;
  env: Record<string, string>;
}

export function net(name?: string): Net {
  const env = { ...loadEnv(), ...process.env } as Record<string, string>;
  const key = (name ?? env.YUKI_NETWORK ?? "local") as NetworkKey;
  if (!NETWORKS[key]) throw new Error(`unknown network "${key}": use local, testnet or mainnet`);
  const rpcUrl = env.NEAR_RPC_URL || NETWORKS[key].rpcUrl;
  const seed = key === "local" ? (env.YUKI_SEED ?? LOCAL_SEED) : env.YUKI_SEED;
  if (!seed) throw new Error("YUKI_SEED is not set: run `pnpm wallets <network>` first");
  const root = env.YUKI_ROOT ?? (key === "local" ? "yuki.sandbox" : "");
  if (!root) throw new Error("YUKI_ROOT is not set: it is the account that will own the contracts and the agents");
  return { key, rpcUrl, rpc: new NearRpc(rpcUrl), root, seed, env };
}

/** Every key follows from the seed and the account's name under the root. */
export function keyFor(n: Net, name: string): KeyPair {
  return accountKey(n.seed, name);
}

export function rootAccount(n: Net): NearAccount {
  const secret = n.env.YUKI_ROOT_KEY ?? (n.key === "local" ? keyFor(n, "root").secretKey : "");
  if (!secret) throw new Error("YUKI_ROOT_KEY is not set");
  return new NearAccount(n.rpc, n.root, secret);
}

export function subAccount(n: Net, name: string): NearAccount {
  return new NearAccount(n.rpc, `${name}.${n.root}`, keyFor(n, name).secretKey);
}

export function deploymentPath(network: string): string {
  return join(ROOT, "Blockchain", "deployments", `${network}.json`);
}

export function readDeployment(network: string): Deployment | null {
  const file = deploymentPath(network);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Deployment) : null;
}

export function writeDeployment(d: Deployment): void {
  mkdirSync(join(ROOT, "Blockchain", "deployments"), { recursive: true });
  writeFileSync(deploymentPath(d.network), JSON.stringify(d, null, 2) + "\n");
}

export const near = (n: number | string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
