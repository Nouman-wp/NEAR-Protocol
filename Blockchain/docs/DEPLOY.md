# Deploying Yuki

Locally, nothing needs deploying by hand: `pnpm dev` and `pnpm sim` start a NEAR sandbox and deploy everything themselves. This guide covers NEAR testnet, and what changes for mainnet.

## 1. Keys and the root account

```bash
pnpm wallets testnet
```

This writes `.env.testnet`, which is git-ignored. It holds:

| Setting | What it is |
|---|---|
| `YUKI_ROOT` | The root account, e.g. `yuki-1a2b3c.testnet`. The contracts and every agent are its sub-accounts, so it must be a **named** account |
| `YUKI_ROOT_KEY` | A fresh full-access key for the root account |
| `YUKI_SEED` | The master seed. The clearer's key and every agent's key are derived from it and the account name, so a restarted backend finds its accounts again. Keep it secret, and keep a copy |
| `ADMIN_TOKEN` | Protects the scenario runner |

The root account must exist, hold the root key as a full-access key, and hold about **12 testnet NEAR**. There are three ways to get there:

- **Faucet helper:** `pnpm wallets testnet --create` asks NEAR's testnet faucet helper to create the account with the key. It may be rate limited.
- **Your own account with our key:** create the account in any NEAR wallet, then add the printed public key to it as a full-access key.
- **Your own account and key:** use an account you already have, and put its own secret key in `YUKI_ROOT_KEY`.

Then fund it from a testnet faucet such as https://near-faucet.io, and check:

```bash
pnpm wallets testnet --check
```

### What 12 NEAR pays for

| Item | NEAR |
|---|---|
| The three contract accounts: code storage plus room for state | about 9 |
| Clearer's gas | about 1.2 |
| 25 agent accounts (12 buyers, 4 sellers and 9 research agents), about 0.06 each | about 1.5 |

The testnet env file sets a smaller market (`SIM_BUYERS=12`, `SIM_SELLERS=4`) and keeps traffic on demand (`FLEET_BACKGROUND=off`). Rounds and settlements happen when someone runs a scenario, because each one adds contract state. Old epochs and rounds are pruned (DECISIONS §13), so storage stays bounded. To keep the swarm trading continuously, set `FLEET_BACKGROUND=on` and fund the contract accounts for the extra state.

## 2. Deploy the contracts

```bash
pnpm deploy:testnet
```

This creates `clearer.<root>`, `usdc.<root>`, `intents.<root>` and `clearing.<root>`, deploys the three contracts from `Blockchain/contracts/res/` and initialises the coordinator. It writes `Blockchain/deployments/testnet.json`. Commit that file: the README links to it, and the backend reads it.

The command is safe to run again. Existing accounts are kept, and a contract is redeployed only if its code changed. Contract state persists across a code upgrade, and the ledger file name stays the same.

Changing the token or the verifier after the first deployment needs a new root account, because the coordinator is initialised with them.

## 3. Run the backend

```bash
pnpm serve testnet
```

This starts the clearing service (`:8787`), the swarm (`:8788`) and an edge proxy on one port (`:8790`). The swarm creates and funds its agents' sub-accounts in its first minutes. On a public network quiet epochs stay open, so an idle backend sends no transactions.

### Expose it

- **Quick tunnel:** `pnpm serve testnet --tunnel` opens a Cloudflare quick tunnel (cloudflared must be installed) and writes its URL to `.data/tunnel-testnet.url`.
- **Your own server:** any Ubuntu machine works.

```bash
sudo bash Backend/deploy/setup.sh yuki-api.example.org
# copy .env.testnet and Blockchain/deployments/testnet.json to /opt/yuki, then
sudo systemctl enable --now yuki@testnet
```

The setup script installs Node 24, pnpm and Caddy (which handles HTTPS), creates a `yuki` user and runs the backend under systemd.

Set the public URLs in `.env.testnet`, because agent cards are registered on chain under `PUBLIC_FLEET_URL`:

```
PUBLIC_API_URL=https://yuki-api.example.org
PUBLIC_FLEET_URL=https://yuki-api.example.org
PUBLIC_WEB_URL=https://yuki.example.org
```

## 4. Publish the website

```bash
pnpm publish:web testnet --backend https://yuki-api.example.org
```

This builds the website and deploys it to Vercel (the Vercel CLI must be logged in, with `Frontend` linked to a project). Vercel proxies `/v1`, `/agents/<slug>`, `/guest(s)` and `/control` to the backend, so the site, the API and the agent cards share one domain. The live WebSocket feed connects to the backend directly.

## 5. Check it

| Do this | You should see |
|---|---|
| `curl https://yuki-api.example.org/v1/health` | `ok: true`: the chain is reachable, the verifier answers, and the swarm is ready |
| Open the website, then Live floor | The swarm trading. Run a scenario with the `ADMIN_TOKEN` from `.env.testnet` |
| Open Verify | "Everything matches", read from `rpc.testnet.fastnear.com` |
| `https://testnet.nearblocks.io/address/clearing.<root>` | Every round, posting, finalisation and settlement transaction |

## Optional: Supabase mirror

To keep an off-server copy of the ledger:

1. Paste `Backend/supabase/schema.sql` into the Supabase SQL editor.
2. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (server side only) in the env file.

Every write is then mirrored. `node Blockchain/scripts/db-restore.mjs testnet` rebuilds a ledger from the mirror on a new server.

## Mainnet

The code paths are the same. What changes is the configuration:

```
YUKI_NETWORK=mainnet
YUKI_INTENTS_CONTRACT=intents.near
SETTLEMENT_TOKEN=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1   # native USDC on NEAR
```

The deploy script refuses mainnet without a real token and `intents.near`. The test token and intents-lite are never deployed there. Agents then deposit real USDC into `intents.near`, and every epoch settles as one `execute_intents` batch on the real verifier. Contract storage alone needs about 4 NEAR, plus the clearer's gas and the agents' accounts. This project has not been deployed to mainnet.
