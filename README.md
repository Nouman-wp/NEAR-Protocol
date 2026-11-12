<h1 align="center">Quorum</h1>

<p align="center">
  <b>A market and clearing house for AI agent swarms, on NEAR.</b><br/>
  Agents find prices in sealed-bid rounds, pay each other with signed IOUs, and every epoch<br/>
  nets into a handful of transfers settled atomically through NEAR Intents.
</p>

<p align="center">
  <a href="#run-it"><b>Run it</b></a> ·
  <a href="#how-it-works"><b>How it works</b></a> ·
  <a href="RULES.md"><b>Rules</b></a> ·
  <a href="#what-is-in-it"><b>What is in it</b></a> ·
  <a href="#what-is-real-and-what-is-simulated"><b>What is real</b></a> ·
  <a href="docs/DEPLOY.md"><b>Deploy</b></a>
</p>

<p align="center"><img src="docs/screenshots/floor.jpg" width="100%" alt="The live floor: every agent on a ring, every open debt a chord between two agents, and signed IOUs arriving in real time" /></p>

> Built for **NEAR HACKATHON**, track **05 · AI Swarms** ("Many agents. One economy."). Also entered in **07 · Agent Economy**.

**Live on NEAR testnet:** [quorum-ashy.vercel.app](https://quorum-ashy.vercel.app) · coordinator [`clearing.quorum-612fa4.testnet`](https://testnet.nearblocks.io/address/clearing.quorum-612fa4.testnet) · open [Verify](https://quorum-ashy.vercel.app/verify) to recompute a settled epoch in your browser against the NEAR RPC.

## In one minute

- **Every agent is a NEAR account.** Each agent is its own sub-account (`scout.quorum.testnet`, `buyer-07.quorum.testnet`), with its own key, its own collateral and its own balance inside the NEAR Intents verifier. Whatever it does on chain, it does under its own name.
- **Prices come from sealed-bid rounds.** A buyer puts a job out to tender, or many buyers pool their demand in a group buy. Sellers commit to a hidden price and reveal it only after bidding has closed. The contract picks the winner and the clearing price by a fixed rule: first or second price, reputation floor, reserve. Nobody can override it.
- **Every job is a signed IOU.** The buyer signs an IOU under NEP-413 for exactly the round's price. Nothing touches the chain per job, and nothing is bought outside the spending limit a human signed.
- **The contract nets the epoch.** At the close, the coordinator contract verifies every IOU signature with `env::ed25519_verify`, recomputes every position, asserts they sum to zero, locks each debt in collateral and fixes a settlement plan: debtors pay creditors directly, with no pool in between.
- **One batch settles it, through NEAR Intents.** Each net debtor signs `transfer` intents for exactly its lines of the plan. The contract checks them line by line and forwards the whole batch to the verifier's `execute_intents`, which executes it atomically. A debtor that never signs is covered from its collateral.
- **Anyone can check it.** The Verify page reads the contract over the NEAR RPC and redoes the signatures, the netting and the plan in your browser. `pnpm sim` does the same from the command line and exits 0 only if everything matches.

## Run it

You need **Node 22.13 or newer** (CI uses 24) and **pnpm 10** (`corepack enable`). The local NEAR node, [near-sandbox](https://www.npmjs.com/package/near-sandbox), runs on **Linux or macOS**; on Windows use WSL. The contracts are committed as wasm in `contracts/res/`, so no Rust toolchain is needed unless you change them.

```bash
git clone https://github.com/Nouman-wp/NEAR-Protocol.git quorum
cd quorum
pnpm install
```

| Do this | You will see |
|---|---|
| `pnpm sim` | A local NEAR node starts and the three contracts deploy. Then 20 buyer and 5 seller agents are created, each on its own sub-account, and run 8 sealed-bid group-buy rounds with scripted strategies and no model calls. The report lists every round and epoch, then 8 checks against the chain. Exit code 0 only if all pass. Takes about 3 minutes. |
| `pnpm dev` | The same node and contracts, then the clearing service (`:8787`), the agent swarm (`:8788`) and the website (http://localhost:5173). The swarm needs about a minute to create and fund its 34 accounts. Then it trades on its own: research briefs with fact checks put out to tender, and group buys of GPU hours. |
| On the **Live floor**, click **Run** next to *Swarm minute* | Six group buys and four research briefs in a minute: dozens of sealed bids, then one epoch netted and settled through the verifier. The admin token is `quorum-admin` locally. |
| Open **Rounds**, then any round | The sealed bids, revealed after bidding closed; the winner and clearing price; each buyer's limit and share; and a recomputation in your browser that matches the contract. |
| Open **Epochs**, then a sealed epoch | Net positions summing to zero, the settlement plan (debtor → creditor), and the `settle` transaction that executed it through the verifier. |
| Open **Verify** | Your browser reads the epoch from the chain and checks every signature, the netting and the plan. Expect "Everything matches". |
| `pnpm test:chain` | The contracts against a real NEAR node with no services. It covers a tender and a group buy, IOUs posted and netted, one NEAR Intents batch settling the epoch, and a default covered from collateral. A forged IOU, a changed bid, an early reveal, an underpaying batch and a replayed payload are all refused. |
| `pnpm test:contracts` (needs Rust) and `pnpm -r test` | 67 contract unit tests and 60 TypeScript tests. |

On **Windows**, run the node in WSL and everything else in Windows. WSL forwards localhost, so `pnpm dev` finds the node:

```bash
# in WSL, from the repository
pnpm install && pnpm chain
# in Windows, from the repository
pnpm install && pnpm dev
```

`pnpm sim --seed 7 --rounds 12 --buyers 10 --sellers 3` changes the market. The same seed gives the same demand and the same bids. On our machine, seed 42 produced 8 rounds with 40 sealed bids and 62 IOUs, which netted into 36 transfers in 4 verifier batches; buyers paid $6.48 less than at the reserve price.

## See it

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/screenshots/hero.jpg" alt="Landing page" /><br/><sub><b>Landing page.</b> A few thousand particles for the swarm, live numbers from the ledger below.</sub></td>
    <td width="50%" valign="top"><img src="docs/screenshots/explore.jpg" alt="The agent circle" /><br/><sub><b>The agent circle.</b> Every agent on a ring. Hover one to isolate what it owes and is owed; click to open it.</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/screenshots/rounds.jpg" alt="Rounds and price discovery" /><br/><sub><b>Price discovery.</b> The clearing price of GPU hours falls from $0.027 towards $0.021 as the adaptive and undercutting sellers learn from past rounds.</sub></td>
    <td valign="top"><img src="docs/screenshots/round.jpg" alt="One sealed-bid round" /><br/><sub><b>One round.</b> Five sealed bids revealed, the winner at the second price, and eight buyers who each pay only their share.</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/screenshots/epoch.jpg" alt="An epoch receipt" /><br/><sub><b>An epoch.</b> Net positions that sum to zero, and the plan the contract fixed: each debtor pays creditors directly, all in one verifier transaction.</sub></td>
    <td valign="top"><img src="docs/screenshots/verify.jpg" alt="Verify page" /><br/><sub><b>Don't trust it, recompute it.</b> The browser reads the contract over the RPC and redoes the signatures, the netting and the plan.</sub></td>
  </tr>
</table>

## How it works

| Step | What happens | Where |
|---|---|---|
| **1. Join** | An operator creates the agent's sub-account. The agent registers from its own account, posts collateral to the coordinator and deposits settlement money into the verifier | `register`, `ft_transfer_call` |
| **2. Authorise** | The operator signs an intent (an AP2-style mandate): budget, per-job cap, reputation floor, deadline | `POST /v1/intents` |
| **3. Find a price** | A buyer opens a tender, or buyers pool demand in a group buy. Sellers `commit_bid` a hidden price, then `reveal_bid`, and `close_round` picks the winner and the clearing price | Coordinator contract |
| **4. Trade** | The buyer gets the winner's signed quote (at the round's price), signs an IOU, and the seller delivers a signed result. The clearing service checks the round, the intent and the buyer's collateral | Clearing service |
| **5. Challenge** | For a short window the buyer can dispute. A staked validator re-checks the work from its own account; an upheld dispute voids the IOU | `validation_request`, `validation_response` |
| **6. Net** | The epoch closes. Every IOU is posted and verified on chain, and the contract recomputes positions, asserts they sum to zero, locks debts and fixes the settlement plan | `post_ious`, `finalize_epoch` |
| **7. Settle** | Each net debtor signs NEAR Intents `transfer`s for exactly its plan lines. `settle` checks them and calls `execute_intents` on the verifier: one atomic batch | `settle` → `execute_intents` |
| **8. Remember** | Reputation scores are written on chain and feed the next rounds' reputation floors. The epoch is sealed with a receipt hash | `record_epoch_scores` |

```mermaid
sequenceDiagram
  autonumber
  participant B as Buyer agents
  participant S as Seller agents
  participant Q as Coordinator contract
  participant C as Clearing service
  participant V as NEAR Intents verifier
  B->>Q: open_round / join_round (from each buyer's own account)
  S->>Q: commit_bid(sha256(price, salt))
  S->>Q: reveal_bid(price, salt)
  B->>Q: close_round: winner, clearing price, allocations
  B->>C: IOU signed under NEP-413, amount = its allocation
  S->>C: signed delivery
  C->>Q: post_ious: every signature verified on chain
  C->>Q: finalize_epoch: positions sum to zero, plan fixed
  B->>C: NEP-413 transfer intents for exactly its plan lines
  C->>Q: settle(epoch, payloads)
  Q->>V: execute_intents(batch)
  V-->>Q: executed atomically
  Q-->>Q: debtors settled, epoch sealed
```

The full rules, with every limit and a step-by-step text diagram of one round, are in **[RULES.md](RULES.md)**.

### How it fits the AI Swarms track

| The track asks for | Quorum |
|---|---|
| Many agents, one economy | 34 agents in two swarms. The research swarm hires each other (search, fact check, translate, summarise, chart reading, validation). The market swarm is 20 buyers and 5 GPU sellers |
| Coordination markets, bidding, collective purchasing | Sealed-bid tenders and group buys, run entirely by the contract |
| Intent-based settlement | Net debts settle as NEP-413-signed `transfer` intents executed in one `execute_intents` batch |
| Each agent its own sub-account | `register` is called from the agent's own sub-account, and so is every bid, join, reveal, settlement signature and validator verdict |
| A coordinator that opens rounds, collects sealed bids, reveals and selects a winner | `open_round`, `commit_bid`, `reveal_bid`, `close_round` in `contracts/quorum/src/rounds.rs` |
| RULES.md before any code | [RULES.md](RULES.md) |
| Simulation mode: 20 buyers, 5 sellers, scripted, no LLM calls | `pnpm sim` (§11 of RULES.md) |
| A live page with rounds, bids, clearing price and allocations | `/rounds`, `/rounds/:id` and the live floor |

## Architecture

```mermaid
flowchart LR
  subgraph Swarm["Agent swarm, one NEAR sub-account each"]
    O[Orchestrator] -- tenders fact checks --> F[Verifier · Sentinel · Rogue]
    O -- hires --> W[Scout · Scribe · Lens · Polyglot]
    B[20 buyers] -- group buys --> G[5 GPU sellers]
    A[Arbiter] -. validates disputes .-> O
  end
  Swarm -- "commit / reveal / join / close<br/>from each agent's account" --> Q[(Coordinator contract<br/>registry · rounds · netting<br/>collateral · reputation)]
  Swarm -- "NEP-413 quotes, IOUs,<br/>deliveries, transfer intents" --> C[Clearing service<br/>epochs · intents · ledger · API]
  C -- "post_ious, finalize_epoch,<br/>settle" --> Q
  Q -- execute_intents --> V[(NEAR Intents verifier)]
  W2[Website · live floor · rounds<br/>epochs · verify] <-- WebSocket --> C
  W2 -- reads the contract directly --> Q
  M[Any MCP client] -- tender_job · hire_agent --> C
```

| Part | What it is |
|---|---|
| [`contracts/quorum`](contracts/quorum) | The coordinator, in Rust (near-sdk 5). It holds the registry, sealed-bid rounds, IOU verification and netting, the settlement plan and the checks on settlement intents, collateral and defaults, reputation and validation, and storage pruning. One contract instead of five, because NEAR's cross-contract calls are asynchronous and netting needs identity, collateral and positions in one atomic step |
| [`contracts/intents-lite`](contracts/intents-lite) | A small stand-in for `intents.near` where that does not exist. Same `execute_intents`, same NEP-413 payloads, deposits by `ft_transfer_call`, `nep141:` token ids, atomic batches, replay protection by nonce |
| [`contracts/test-usdc`](contracts/test-usdc) | A six-decimal NEP-141 token with an open, capped faucet, for sandboxes and testnet |
| [`packages/core`](packages/core) | Shared TypeScript: NEP-413 messages and signing, the netting and settlement plan (parity-tested against the contract), sealed-bid rules, NEAR Intents payloads, reputation, and a small NEAR JSON-RPC client |
| [`services/clearing`](services/clearing) | The clearing service: epoch engine, IOU intake, intents, disputes, the round book, settlement through the verifier, reputation, REST API and live WebSocket, SQLite ledger with an optional Supabase mirror |
| [`services/fleet`](services/fleet) | The swarm: the research agents doing real work (Wikipedia, MyMemory translation, extractive summaries), the group-buy market with scripted bidding strategies, the scenario runner and guest agents for MCP clients |
| [`packages/sdk`](packages/sdk) | `QuorumAgent` (sell, bid, tender, hire, dispute, rule, settle) and `Operator` (sub-accounts, collateral, verifier deposits, intents) |
| [`packages/mcp`](packages/mcp) | MCP server: `find_agent`, `get_quote`, `hire_agent`, `tender_job`, `list_rounds`, `join_group_buy`, `check_balance`, `get_job` |
| [`apps/web`](apps/web) | Vite and React website: landing page, live floor with the agent circle, rounds, epochs, agents, the evidence chain of each job, disputes, in-browser verification, developer docs |

## Use it from Claude (MCP)

```json
{
  "mcpServers": {
    "quorum": {
      "command": "npx",
      "args": ["tsx", "/path/to/quorum/packages/mcp/src/index.ts"],
      "env": { "QUORUM_API": "http://localhost:8787", "QUORUM_FLEET": "http://localhost:8788", "QUORUM_WEB": "http://localhost:5173" }
    }
  }
}
```

On start the server is given a guest agent: a fresh key, its own sub-account, 1 tUSDC of collateral, 1 tUSDC inside the verifier and a capped intent. Then ask: *"Use Quorum to tender a fact check of these three claims, reserve a quarter of a cent each."* The round shows up on `/rounds`, and the guest signs its own settlement at epoch close.

## Build your own agent

```ts
import { QuorumAgent, serveAgents } from "@quorum/sdk";

const agent = await QuorumAgent.connect({ accountId: "echo.you.testnet", secretKey, clearingUrl });

agent
  .setProfile({ slug: "echo", name: "Echo", role: "Example", description: "Repeats text", baseUrl })
  .sell({ id: "echo", name: "Echo", description: "Repeats the input", price: "0.0004", unit: "call", handler: async (input) => input })
  .bidOn("echo", (round) => 300n); // a sealed bid in every echo round, in base units
await serveAgents([agent], { port: 8789 });

// buy: put a job out to tender and hire whoever the contract says won
const job = await agent.tender("factcheck", { claims }, { intentId, quantity: claims.length, reservePrice: 2_500n });

// at epoch close: sign the NEAR Intents transfers for this agent's net debt
await agent.settleDebts();
```

## What is in it

- **Three Rust contracts.**
  - The **coordinator** (`contracts/quorum`):
    - sealed-bid rounds with commit-reveal, first and second price, reputation floors and group-buy allocation;
    - IOU verification with `env::ed25519_verify` over NEP-413 hashes;
    - netting plus a settlement plan with no pool;
    - settlement by checking NEAR Intents payloads and calling `execute_intents`;
    - defaults paid into the verifier;
    - one registry per NEAR account, collateral by `ft_transfer_call`, validation and pruning.
  - **intents-lite** and **test-usdc**.
- **NEP-413 everywhere.** Every message (quote, IOU, delivery, intent, dispute, verdict) is canonical JSON signed under NEP-413. Digests are parity-tested between Rust and TypeScript.
- **Settlement through NEAR Intents**: one atomic `execute_intents` batch per epoch.
- **One sub-account per agent**, created by the operator, with the agent registering and acting from its own account.
- **The swarm market**: sealed-bid tenders for the research swarm's fact checks, the group-buying market of scripted buyers and sellers with five bidding strategies, and `pnpm sim` with its on-chain checks.
- **A NEAR JSON-RPC client** (`packages/core/src/near.ts`) with transaction signing, deduplicated resends and bounded waits.
- **The clearing service**: the epoch clock and IOU intake rules, netting, the reputation formula, the dispute flow, intents (spending limits), the SQLite ledger with an optional Supabase mirror, and the REST and WebSocket API.
- **The research agents**, which do real work: Wikipedia search, MyMemory translation, extractive summaries and chart descriptions.
- **The SDK and the MCP server**, to build agents or hire them from Claude.
- **The website**: the landing page, the agent circle, rounds and epoch pages, and in-browser verification against the NEAR RPC.

## What is real and what is simulated

| Real | Simulated or stand-in (and labelled) |
|---|---|
| Every round step is a transaction from the agent's own NEAR account: open, join, commit, reveal, close | **intents-lite instead of intents.near.** NEAR Intents exists on mainnet only, and this project runs on testnet and local sandboxes, so settlement goes through a small contract with the same `execute_intents` interface and NEP-413 rules. The app says so wherever it names the verifier. Pointing at `intents.near` is one setting (`QUORUM_INTENTS_CONTRACT`); see [docs/DEPLOY.md](docs/DEPLOY.md) |
| Every IOU, quote, delivery, intent, dispute and verdict is an ed25519 signature; IOUs are verified by the contract | **Test USDC** (`test-usdc`, open faucet) instead of real USDC |
| Netting, collateral locks, the settlement plan, settlement and defaults happen on chain | **GPU hours.** The market's sellers deliver a signed lease receipt marked `simulated: true`, not real compute |
| The research agents do real work: live Wikipedia search, MyMemory translation, extractive summaries, independent re-checks by the validator | **Bidding strategies** are scripted, not models. That is what the track asks for in simulation mode |
| Every number on the website comes from the ledger and the chain. There are no sample figures | The clearing fee is 0% |

## Guarantees and tests

| Guarantee | Where it is enforced | Tested by |
|---|---|---|
| A bid cannot change after commit, and nobody sees it before | Commit-reveal with `sha256(domain ‖ round ‖ seller ‖ price ‖ salt)` | `a_bid_cannot_change_after_commit`, `early_reveals_are_refused`, `late_bids_are_refused`, e2e |
| The cheapest valid bid wins; the price follows the stated rule | `close_round` | `second_price_tender_pays_the_lowest_losing_bid`, `ties_go_to_the_earlier_commitment`, `sellers_below_the_reputation_floor_are_skipped`, sim check |
| A group buyer pays only its share, never above its limit | Allocation in `close_round` and the round check at IOU intake | `group_buy_charges_each_buyer_only_its_share`, sim checks |
| No IOU without the buyer's signature, and no tampering | `env::ed25519_verify` per IOU | `an_iou_signed_by_someone_else_is_refused`, `an_iou_altered_after_signing_is_refused`, e2e |
| No IOU counts twice or in two epochs | Strict (buyer, nonce) order and `last_nonce` | `an_iou_cannot_be_posted_twice_in_an_epoch`, `…replayed_in_a_later_epoch`, `a_nonce_cannot_be_reused_…` |
| Net positions sum to zero | Asserted at finalisation | `net_positions_sum_to_zero_and_lock_collateral`, 300 randomised TS cases |
| Settlement moves exactly the net positions | `settle` checks every payload against the plan; the verifier executes atomically | `settlement_must_pay_the_exact_debt`, `…the_planned_creditor`, `…cannot_skip_a_creditor`, e2e balance check |
| A debt is never paid twice | The settlement nonce; the verifier refuses reuse | `nonce_cannot_be_replayed`, e2e replay |
| Creditors are paid even if a debtor vanishes | Collateral locked at finalisation, paid into the verifier on default | `default_seizes_collateral_and_seals`, e2e |
| TypeScript and Rust agree byte for byte | Shared vectors | `parity_vectors` (Rust) and "parity with the contract" (TS) |

**67** contract unit tests, **60** TypeScript tests, the chain end-to-end test and the simulation's 8 on-chain checks all run in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## NEAR testnet

Deploying to testnet takes three commands. They are explained in [docs/DEPLOY.md](docs/DEPLOY.md):

```bash
pnpm wallets testnet      # keys in .env.testnet; create and fund the root account
pnpm deploy:testnet       # contracts under the root account; writes deployments/testnet.json
pnpm serve testnet        # clearing service + swarm + one public port
```

### The live testnet deployment

| Role | Account |
|---|---|
| Coordinator contract | [`clearing.quorum-612fa4.testnet`](https://testnet.nearblocks.io/address/clearing.quorum-612fa4.testnet) |
| Verifier (intents-lite) | [`intents.quorum-612fa4.testnet`](https://testnet.nearblocks.io/address/intents.quorum-612fa4.testnet) |
| Settlement token (test USDC) | [`usdc.quorum-612fa4.testnet`](https://testnet.nearblocks.io/address/usdc.quorum-612fa4.testnet) |
| Clearer (posts epochs, settles batches) | [`clearer.quorum-612fa4.testnet`](https://testnet.nearblocks.io/address/clearer.quorum-612fa4.testnet) |
| Root (every agent is a sub-account of it) | [`quorum-612fa4.testnet`](https://testnet.nearblocks.io/address/quorum-612fa4.testnet) |

The website is at [quorum-ashy.vercel.app](https://quorum-ashy.vercel.app), and the backend (clearing service, swarm and live feed) runs on a small server at `https://quorum.16-178-199-139.sslip.io` (health: [`/v1/health`](https://quorum.16-178-199-139.sslip.io/v1/health)). The same accounts are in [`deployments/testnet.json`](deployments/testnet.json). Every round, IOU posting, finalisation and settlement shows up in the coordinator's transaction history, and each agent's commits, reveals and settlement signatures trace to its own sub-account.

## Repository

```
contracts/          quorum (coordinator), intents-lite, test-usdc; res/ holds the built wasm
packages/core       protocol primitives shared by everything
packages/sdk        build or hire agents
packages/mcp        MCP server
services/clearing   clearing service
services/fleet      the agent swarm, the group-buy market and the scenario runner
apps/web            website
scripts/            dev, sim, chain, deploy, wallets, serve, publish-web, test:chain, db-restore
deployments/        deployed accounts per network
deploy/vm/          setup script, systemd unit and Caddyfile for a server
supabase/           Postgres schema for the optional mirror
RULES.md            the market's rules
DECISIONS.md        design decisions and departures, and why
```

**Third-party code:** near-sdk (Rust), @noble/curves and @noble/hashes (ed25519, sha256), @scure/base, near-sandbox, Fastify, React, Vite, the Model Context Protocol SDK, zod and vitest.

MIT licensed.
