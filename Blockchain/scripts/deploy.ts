// Deploy Yuki's contracts under one root account. Safe to run again: accounts that
// exist are kept, and a contract is redeployed only when its code changed.
//
//   tsx Blockchain/scripts/deploy.ts local      near-sandbox on 127.0.0.1:3030
//   tsx Blockchain/scripts/deploy.ts testnet    needs YUKI_ROOT, YUKI_ROOT_KEY and YUKI_SEED in .env.testnet
//
// Layout under the root account R:
//   clearing.R   the coordinator contract
//   usdc.R       test USDC (skipped when SETTLEMENT_TOKEN names a real token)
//   intents.R    intents-lite, a stand-in for intents.near (skipped when YUKI_INTENTS_CONTRACT is set)
//   clearer.R    the clearing service's account
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NEAR_INTENTS_ACCOUNT, NearAccount, TGAS, bytesToHex, sha256Bytes, toBase58, type Deployment } from "@yuki/core";
import { ROOT, useNetworkEnv } from "./lib.mjs";
import { SANDBOX_ROOT, keyFor, near, net, readDeployment, rootAccount, subAccount, writeDeployment, type Net } from "./net.ts";

const say = (m: string) => console.log(`deploy  │ ${m}`);

function wasm(name: string): Uint8Array {
  const file = join(ROOT, "Blockchain", "contracts", "res", `${name}.wasm`);
  if (!existsSync(file)) throw new Error(`${file} is missing: run \`pnpm build:contracts\` first`);
  return new Uint8Array(readFileSync(file));
}

const codeHash = (code: Uint8Array) => toBase58(sha256Bytes(code));

async function ensureSub(n: Net, parent: NearAccount, name: string, balance: bigint): Promise<NearAccount> {
  const acc = subAccount(n, name);
  if (!(await n.rpc.account(acc.accountId))) {
    await parent.createSubAccount(name, acc.publicKey, balance);
    say(`created ${acc.accountId}`);
  }
  return acc;
}

/** Deploy `code` to the account if it differs from what is there. Returns true on a first deploy. */
async function ensureCode(n: Net, acc: NearAccount, name: string, code: Uint8Array, init: { method: string; args: unknown }): Promise<boolean> {
  const state = await n.rpc.account(acc.accountId);
  if (state?.codeHash === codeHash(code)) return false;
  const fresh = state?.codeHash === "11111111111111111111111111111111";
  const r = await acc.deploy(code, fresh ? init : undefined);
  say(`${fresh ? "deployed" : "upgraded"} ${name} at ${acc.accountId} (${(code.length / 1024).toFixed(0)} kB, tx ${r.hash})`);
  return fresh;
}

export async function deploy(network = "local"): Promise<Deployment> {
  useNetworkEnv(network);
  const n = net(network);
  const local = n.key === "local";

  if (local && !(await n.rpc.account(n.root))) {
    const sandbox = new NearAccount(n.rpc, SANDBOX_ROOT.accountId, SANDBOX_ROOT.secretKey);
    await sandbox.createSubAccount(n.root.split(".")[0]!, keyFor(n, "root").publicKey, near(5_000));
    say(`created ${n.root}`);
  }
  const root = rootAccount(n);
  const state = await n.rpc.account(root.accountId);
  if (!state) throw new Error(`${root.accountId} does not exist on ${n.key}`);
  say(`root ${root.accountId} holds ${(Number(state.amount / 10n ** 21n) / 1000).toFixed(2)} NEAR`);

  // storage costs about 1 NEAR per 100 kB of contract code, plus room for state
  const fund = (localAmount: number, publicAmount: number) => near(local ? localAmount : publicAmount);
  const realToken = n.env.SETTLEMENT_TOKEN || "";
  const realIntents = n.env.YUKI_INTENTS_CONTRACT || "";
  if (n.key === "mainnet" && (!realToken || !realIntents)) {
    throw new Error("on mainnet set SETTLEMENT_TOKEN (a real NEP-141 token) and YUKI_INTENTS_CONTRACT=intents.near: the test token and intents-lite are for sandboxes and testnet only");
  }

  const clearer = await ensureSub(n, root, "clearer", fund(50, 1.2));
  let token = realToken;
  if (!token) {
    const usdc = await ensureSub(n, root, "usdc", fund(20, 1.7));
    await ensureCode(n, usdc, "test-usdc", wasm("test_usdc"), { method: "new", args: {} });
    token = usdc.accountId;
  }
  let intents = realIntents;
  if (!intents) {
    const lite = await ensureSub(n, root, "intents", fund(30, 2.4));
    await ensureCode(n, lite, "intents-lite", wasm("intents_lite"), { method: "new", args: {} });
    intents = lite.accountId;
  }

  const settlementWindowMs = Number(n.env.SETTLEMENT_WINDOW ?? (local ? 45 : 180)) * 1000;
  const withdrawalDelayMs = Number(n.env.WITHDRAWAL_DELAY ?? (local ? 300 : 3600)) * 1000;
  const minValidatorStake = n.env.MIN_VALIDATOR_STAKE ?? "1000000";
  const clearing = await ensureSub(n, root, "clearing", fund(60, 5));
  const previous = readDeployment(n.key);
  const fresh = await ensureCode(n, clearing, "quorum", wasm("quorum"), {
    method: "new",
    args: {
      owner: root.accountId,
      clearer: clearer.accountId,
      token,
      intents,
      settlement_window_ms: settlementWindowMs,
      withdrawal_delay_ms: withdrawalDelayMs,
      min_validator_stake: minValidatorStake,
    },
  });

  const config = await n.rpc.view<{ token: string; intents: string; clearer: string }>(clearing.accountId, "get_config");
  if (config.token !== token || config.intents !== intents) {
    throw new Error(`${clearing.accountId} was initialised for token ${config.token} and verifier ${config.intents}; this run asks for ${token} and ${intents}. Use a new root account to change them.`);
  }
  if (fresh && !realToken) {
    // the faucet registers accounts itself; a real NEP-141 token needs storage_deposit for the contract
    say(`settlement token ${token} (test USDC, open faucet)`);
  } else if (fresh) {
    await root.call(token, "storage_deposit", { account_id: clearing.accountId, registration_only: true }, { deposit: near(0.00125), gas: 30n * TGAS });
    await root.call(token, "storage_deposit", { account_id: intents, registration_only: true }, { deposit: near(0.00125), gas: 30n * TGAS }).catch(() => undefined);
  }

  const d: Deployment = {
    network: n.key,
    root: root.accountId,
    contract: clearing.accountId,
    token,
    mockToken: !realToken,
    intents,
    intentsKind: intents === NEAR_INTENTS_ACCOUNT ? "near-intents" : "intents-lite",
    owner: root.accountId,
    clearer: clearer.accountId,
    clearerKey: clearer.publicKey,
    settlementWindowMs,
    withdrawalDelayMs,
    minValidatorStake,
    // the ledger is named after this: a rerun that redeploys nothing keeps the same ledger
    deployedAt: !fresh && previous?.contract === clearing.accountId && previous.network === n.key ? previous.deployedAt : Date.now(),
  };
  writeDeployment(d);
  say(`coordinator ${d.contract} · token ${d.token} · verifier ${d.intents} (${d.intentsKind})`);
  say(`wrote Blockchain/deployments/${n.key}.json (code ${bytesToHex(sha256Bytes(wasm("quorum"))).slice(0, 18)}…)`);
  return d;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  deploy(process.argv[2] ?? "local").catch((e) => {
    console.error(`deploy  │ failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
