import { deriveKeyPair, type AccountId, type KeyPair, type PublicKey } from "./crypto.ts";
import type { VerifierKind } from "./intents.ts";

export type NetworkKey = "local" | "testnet" | "mainnet";

export interface Network {
  key: NetworkKey;
  name: string;
  /** NEAR network id, as wallets and near-api-js name it */
  networkId: string;
  rpcUrl: string;
  explorer: string | null;
}

export const NETWORKS: Record<NetworkKey, Network> = {
  local: { key: "local", name: "Local sandbox", networkId: "sandbox", rpcUrl: "http://127.0.0.1:3030", explorer: null },
  testnet: { key: "testnet", name: "NEAR testnet", networkId: "testnet", rpcUrl: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io" },
  mainnet: { key: "mainnet", name: "NEAR", networkId: "mainnet", rpcUrl: "https://rpc.mainnet.near.org", explorer: "https://nearblocks.io" },
};

/** The NEAR Intents verifier. It exists on mainnet only. */
export const NEAR_INTENTS_ACCOUNT: AccountId = "intents.near";

export function explorerTx(network: NetworkKey, hash: string): string | null {
  const base = NETWORKS[network].explorer;
  return base ? `${base}/txns/${hash}` : null;
}

export function explorerAccount(network: NetworkKey, account: string): string | null {
  const base = NETWORKS[network].explorer;
  return base ? `${base}/address/${account}` : null;
}

/** Written by scripts/deploy.mjs to deployments/<network>.json. */
export interface Deployment {
  network: NetworkKey;
  /** parent account: agents are its sub-accounts */
  root: AccountId;
  /** the coordinator contract */
  contract: AccountId;
  /** NEP-141 settlement token */
  token: AccountId;
  /** true for Quorum's own test USDC with an open faucet */
  mockToken: boolean;
  /** the verifier that executes settlement intents */
  intents: AccountId;
  intentsKind: VerifierKind;
  owner: AccountId;
  clearer: AccountId;
  clearerKey: PublicKey;
  settlementWindowMs: number;
  withdrawalDelayMs: number;
  minValidatorStake: string;
  deployedAt: number;
}

/** The seed every key of a local sandbox follows from. Public: never use it on a real network. */
export const LOCAL_DEV_SEED = "quorum-local-development-seed";

/** The key of `<name>.<root>`, derived from a deployment's master seed. */
export function accountKey(seed: string, name: string): KeyPair {
  return deriveKeyPair(seed, `quorum/account/${name}`);
}
