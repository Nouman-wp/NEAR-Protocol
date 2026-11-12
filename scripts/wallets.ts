// Keys and an account for a public network.
//
//   pnpm wallets testnet                         new keys in .env.testnet, then create the account
//   pnpm wallets testnet --name quorum-demo      choose the account name (quorum-demo.testnet)
//   pnpm wallets testnet --check                 show the account, its balance and what deploying needs
//
// Writes .env.testnet with a fresh master seed (every agent's key follows from it) and a
// fresh key for the root account. The root account must be a named account, because the
// coordinator, the token, the verifier stand-in and every agent are its sub-accounts.
//
// The account itself has to exist and hold testnet NEAR. This script can ask the NEAR
// testnet faucet helper to create it (--create), or you create it yourself and add the
// printed public key to it (see docs/DEPLOY.md). Keys never leave this machine.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NETWORKS, NearRpc, ONE_NEAR, bytesToHex, keyPairFromSecret, randomBytes, randomKeyPair } from "@quorum/core";
import { ROOT } from "./lib.mjs";

const network = process.argv[2] ?? "testnet";
if (network !== "testnet" && network !== "mainnet") throw new Error("usage: pnpm wallets testnet|mainnet [--name <account>] [--create] [--check]");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (flag: string) => process.argv.includes(`--${flag}`);
const file = join(ROOT, `.env.${network}`);
const suffix = network === "testnet" ? ".testnet" : ".near";
/** what a full deployment needs, in NEAR: contract storage, the clearer's gas, the agents' accounts */
const NEEDED = network === "testnet" ? 12 : 14;

function readEnv(): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const fmt = (yocto: bigint) => (Number(yocto / (ONE_NEAR / 1000n)) / 1000).toFixed(3);

async function check(env: Record<string, string>) {
  const rpc = new NearRpc(env.NEAR_RPC_URL || NETWORKS[network as "testnet"].rpcUrl);
  const root = env.QUORUM_ROOT!;
  const key = keyPairFromSecret(env.QUORUM_ROOT_KEY!).publicKey;
  const account = await rpc.account(root);
  if (!account) {
    console.log(`\n  ${root} does not exist on ${network} yet.`);
    return false;
  }
  const access = await rpc.accessKey(root, key);
  console.log(`\n  ${root}: ${fmt(account.amount)} NEAR`);
  console.log(`  key ${key}: ${access ? (access.fullAccess ? "full access, ready" : "function-call only: it must be a full-access key") : "NOT on the account yet"}`);
  if (account.amount < BigInt(NEEDED) * ONE_NEAR) console.log(`  a full deployment needs about ${NEEDED} NEAR: top it up from a faucet before deploying`);
  return !!access?.fullAccess;
}

async function createWithFaucet(accountId: string, publicKey: string): Promise<boolean> {
  // The helper behind NEAR's testnet wallets: creates a named .testnet account with the key
  // and a starting balance. It may be rate limited or retired; the manual route always works.
  for (const url of ["https://helper.testnet.near.org/account", "https://helper.nearprotocol.com/account"]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return true;
      console.log(`  ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      console.log(`  ${url}: ${(err as Error).message}`);
    }
  }
  return false;
}

async function main() {
  let env = readEnv();
  if (!env.QUORUM_SEED || !env.QUORUM_ROOT_KEY || !env.QUORUM_ROOT) {
    const name = (arg("name") ?? `quorum-${bytesToHex(randomBytes(3)).slice(2)}`).replace(new RegExp(`\\${suffix}$`), "");
    const root = randomKeyPair();
    env = {
      QUORUM_NETWORK: network,
      QUORUM_ROOT: `${name}${suffix}`,
      QUORUM_ROOT_KEY: root.secretKey,
      QUORUM_SEED: bytesToHex(randomBytes(32)).slice(2),
      ADMIN_TOKEN: bytesToHex(randomBytes(16)).slice(2),
      ...env,
    };
    writeFileSync(
      file,
      [
        `# Quorum ${network} configuration, written by \`pnpm wallets ${network}\`. Real keys: never commit this file.`,
        `QUORUM_NETWORK=${network}`,
        `# the named account that owns the contracts and every agent (they are its sub-accounts)`,
        `QUORUM_ROOT=${env.QUORUM_ROOT}`,
        `QUORUM_ROOT_KEY=${env.QUORUM_ROOT_KEY}`,
        `# every agent's and the clearer's key is derived from this seed`,
        `QUORUM_SEED=${env.QUORUM_SEED}`,
        `ADMIN_TOKEN=${env.ADMIN_TOKEN}`,
        `# NEAR_RPC_URL=${NETWORKS[network as "testnet" | "mainnet"].rpcUrl}`,
        `EPOCH_INTAKE_SECONDS=75`,
        `EPOCH_CHALLENGE_SECONDS=18`,
        `SETTLEMENT_WINDOW=300`,
        `# public URLs, once the backend and the website are hosted`,
        `# PUBLIC_API_URL=https://quorum-api.example.org`,
        `# PUBLIC_FLEET_URL=https://quorum-api.example.org`,
        `# PUBLIC_WEB_URL=https://quorum.example.org`,
        `# smaller market on a public network: fewer accounts to fund`,
        `SIM_BUYERS=12`,
        `SIM_SELLERS=4`,
        `NEAR_TARGET=0.06`,
        `# traffic on demand (scenarios): every round and settlement costs contract storage`,
        `FLEET_BACKGROUND=off`,
        `PRUNE_KEEP_EPOCHS=20`,
        `PRUNE_KEEP_ROUNDS=40`,
        ``,
      ].join("\n"),
    );
    console.log(`  wrote ${file}`);
  } else console.log(`  using ${file}`);

  const publicKey = keyPairFromSecret(env.QUORUM_ROOT_KEY!).publicKey;
  console.log(`  root account  ${env.QUORUM_ROOT}`);
  console.log(`  root key      ${publicKey}`);

  if (has("create") && network === "testnet") {
    const rpc = new NearRpc(NETWORKS.testnet.rpcUrl);
    if (await rpc.account(env.QUORUM_ROOT!)) console.log(`  ${env.QUORUM_ROOT} already exists`);
    else {
      console.log(`  asking the testnet faucet helper to create ${env.QUORUM_ROOT}…`);
      if (await createWithFaucet(env.QUORUM_ROOT!, publicKey)) console.log("  created");
      else console.log("  the helper did not create it: use the manual route below");
    }
  }

  const ready = await check(env).catch((err) => {
    console.log(`  could not reach ${network}: ${(err as Error).message}`);
    return false;
  });
  if (!ready) {
    console.log(
      [
        "",
        "  To make the account ready, either:",
        `    a) pnpm wallets ${network} --create        ask the testnet faucet helper to create it (testnet only)`,
        `    b) create ${env.QUORUM_ROOT} in any NEAR wallet, then add the root key above to it as a full-access key,`,
        `       or put that account's own secret key in QUORUM_ROOT_KEY in ${file}`,
        `  Then fund it with about ${NEEDED} NEAR (testnet faucets: https://near-faucet.io) and run: pnpm deploy:${network}`,
        "",
      ].join("\n"),
    );
  } else console.log(`\n  ready: pnpm deploy:${network}\n`);
}

main().catch((err) => {
  console.error(`wallets │ ${(err as Error).message}`);
  process.exit(1);
});
