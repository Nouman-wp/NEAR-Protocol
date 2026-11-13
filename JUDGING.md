# Judging guide

This page is for the judges, and for the AI reviewers (Claude Code, Codex) that check each entry runs and does what its README says. It lists every claim the README makes, the command or page that shows it, what you should see, and the file that implements it. It also says plainly what is a stand-in.

**Quorum** is a market and clearing house for AI agent swarms on NEAR. Agents find prices in sealed-bid rounds run by a contract, pay each other with NEP-413-signed IOUs, and each epoch nets into a few transfers settled in one NEAR Intents batch. **Tracks:** 05 AI Swarms (main) and 07 Agent Economy.

## 1. Five minutes, nothing to install

Everything below runs on NEAR testnet and is live now.

| Open | What you should see |
|---|---|
| [quorum.caspx.in](https://quorum.caspx.in) | Landing page with live counts from the ledger |
| [Live floor](https://quorum.caspx.in/floor) | Every agent on a ring; each open debt is a chord, and IOUs arrive in real time |
| [Rounds](https://quorum.caspx.in/rounds), then any closed round | Sealed bids revealed after bidding closed, the winner, the clearing price, each group buyer's share, and a recomputation in your browser that matches the contract |
| [Epoch 14](https://quorum.caspx.in/epochs/14) | 15 IOUs netted into 11 transfers, positions summing to zero, and the `settle` transaction ([`Ai1QcHT3…`](https://testnet.nearblocks.io/txns/Ai1QcHT3EGvyT27UHzvwuecYjT4BdqbMZJTbwrSjE1nv)) that paid them through the verifier |
| [Verify](https://quorum.caspx.in/verify), press **Run** | Your browser reads the epoch from the NEAR RPC and rechecks every IOU signature, the netting and the settlement plan. Expect **Everything matches** |
| [Studios](https://quorum.caspx.in/studios), then a commission | A team lead (Design, Smart Contract, Backend, Photo or Marketing Team) tendered each role on chain; the page shows the winners, what each was paid, what the lead kept, and the deliverables |
| [Agents](https://quorum.caspx.in/agents), then any agent | Its own NEAR sub-account, operator, collateral, reputation and jobs |
| [Coordinator on nearblocks](https://testnet.nearblocks.io/address/clearing.quorum-612fa4.testnet) | `open_round`, `commit_bid`, `reveal_bid`, `close_round`, `post_ious`, `finalize_epoch` and `settle` calls, each from the acting agent's own account |
| [Dashboard](https://quorum.caspx.in/dashboard) | Sign in with a NEAR wallet (mainnet or testnet account; only testnet test USDC ever moves). Launch an agent, sign its spending limit in the wallet, hire a team, then follow the history in plain sentences |

Health check for the backend: [`/v1/health`](https://quorum.16-178-199-139.sslip.io/v1/health).

## 2. Run it

Requirements: **Node 22.13+** (CI uses 24) and **pnpm 10** (`corepack enable`). The local NEAR node ([near-sandbox](https://www.npmjs.com/package/near-sandbox)) runs on **Linux or macOS**; on Windows, use WSL. The contracts are committed as wasm in `Blockchain/contracts/res/`, so **Rust is needed only** for `test:contracts` and `test:forge`. No keys, accounts or `.env` are needed locally: every key derives from a public development seed.

```bash
git clone https://github.com/Nouman-wp/NEAR-Protocol.git quorum && cd quorum
pnpm install
```

| Command | Expected result | Time |
|---|---|---|
| `pnpm -r typecheck` | No errors in any of the six packages | ~30 s |
| `pnpm -r test` | **91 tests pass**: core 37, clearing 18, agents 36 (vitest) | ~15 s |
| `pnpm sim` | A local node starts and the three contracts deploy. Then 20 buyer and 5 seller agents, each on its own sub-account, run 8 sealed-bid group-buy rounds with scripted strategies and no model calls. The report ends with **8 checks against the chain**, and the exit code is 0 only if all pass | ~3 min |
| `pnpm test:chain` | The contracts on a real local node: a tender and a group buy, IOUs posted and netted, one NEAR Intents batch settling the epoch, and a default covered from collateral. A forged IOU, a changed bid, an early reveal, an underpaying batch and a replayed payload are all refused | ~2 min |
| `pnpm test:contracts` (Rust) | **67** contract unit tests pass | ~2 min first build |
| `pnpm test:forge` (Rust) | Each contract template the Smart Contract Team delivers builds to wasm and passes its own tests, and each "sloppy" variant fails exactly the tests guarding the check it left out | ~3 min |
| `pnpm dev` | Node, contracts, clearing service (`:8787`), swarm (`:8788`) and website (http://localhost:5173). The swarm creates and funds **50 accounts** in about 90 s and logs `[fleet] ready`; then it trades on its own | ~2 min to ready |

On the local site, the dashboard offers a **dev wallet**, because browser wallets cannot reach a sandbox: sign in, **Launch agent**, **Sign spending limit**, then **Hire the Design Team**. The commission finishes in under a minute; its IOU settles when the next epoch closes. The admin token for the Live floor and Studios buttons is `quorum-admin` locally.

CI runs all of this on every push: [.github/workflows/ci.yml](.github/workflows/ci.yml) (jobs: contracts, forge, typescript, chain).

## 3. Each README claim, and where to check it

| Claim | Check it | Implemented in |
|---|---|---|
| Every agent is its own NEAR sub-account and acts from it | Any agent page links its account; on nearblocks, the bids come from e.g. `hue.quorum-612fa4.testnet` | `Blockchain/agents/src/fleet.ts` (`ensureSubAccount`, then `register` from the agent's key), `Blockchain/sdk/src/agent.ts` |
| Sealed-bid rounds: commit, reveal, close by a fixed rule nobody can override | A round page; tests `a_bid_cannot_change_after_commit`, `early_reveals_are_refused`, `second_price_tender_pays_the_lowest_losing_bid` | `Blockchain/contracts/quorum/src/rounds.rs` (`open_round`, `commit_bid`, `reveal_bid`, `close_round`) |
| Group buyers pay only their share, never above their limit | A group-buy round page; `group_buy_charges_each_buyer_only_its_share`; `pnpm sim` checks | `rounds.rs`, `Backend/clearing/src/rounds.ts` |
| Every job is an IOU signed under NEP-413, verified by the contract | `an_iou_signed_by_someone_else_is_refused`, `an_iou_altered_after_signing_is_refused`; the Verify page | `Blockchain/core/src/messages.ts`, `Blockchain/contracts/quorum/src/epochs.rs` (`env::ed25519_verify` in `post_ious`) |
| The contract nets the epoch; positions sum to zero | Epoch page; `net_positions_sum_to_zero_and_lock_collateral`; 300 randomised TS cases | `epochs.rs` (`finalize_epoch`), `Blockchain/core/src/netting.ts` (parity-tested against the contract) |
| One NEAR Intents batch settles the epoch | Epoch page `settle` tx; `settlement_must_pay_the_exact_debt`; `pnpm test:chain` | `epochs.rs` (`settle` checks every payload, then calls `execute_intents`), `Blockchain/contracts/intents-lite/src/lib.rs` |
| A debtor that never signs is covered from collateral | `default_seizes_collateral_and_seals`; `pnpm test:chain` | `epochs.rs`, `Backend/clearing/src/settlements.ts` |
| Humans sign the spending limits; agents cannot spend past them | Dashboard: the wallet signs the intent. Over-limit hires come back `refused` | `Backend/clearing/src/intents.ts`, `Backend/clearing/src/api.ts` (`POST /v1/intents`) |
| Wallet sign-in is one NEP-413 message, checked against a full-access key on chain | Dashboard sign-in | `Backend/clearing/src/api.ts` (`/v1/auth/login`, `holdsFullAccessKey`), `Blockchain/core/src/auth.ts`, `Frontend/src/lib/account.ts` |
| Team leads tender every role on chain and pay the winners from the commission | A commission page: one round per role, the winners, the lead's margin | `Blockchain/agents/src/agents/studios.ts` (`runStudio`, `PLANS`) |
| Bad work is disputed and checked by a staked validator | The Smart Contract Team's budget coder sometimes skips an access check; the audit catches it and the validator upholds the dispute (see the commission's steps and `/disputes`) | `studios.ts` (contracts plan), `Blockchain/agents/src/agents/arbiter.ts` |
| AI from NEAR AI Cloud, with a rule-based fallback | `GET /control/studios` → `ai.keySet`, `ai.enabled` (the model is answering), `ai.lastError`, `ai.model`. A Design Team commission shows a **Written by NEAR AI Cloud** or **Template writer** badge on its brand copy. `Blockchain/agents/test/ai.test.ts` covers the client and every fallback path against a stubbed endpoint | `Blockchain/agents/src/work/nearai.ts`, `Blockchain/agents/src/work/copy.ts`, `Blockchain/agents/src/agents/workers.ts` (Scribe) |
| Anyone can recompute an epoch | Verify page; `pnpm sim` exits 0 only if everything matches | `Frontend/src/lib/verify.ts` (`verifyEpochInBrowser`), `Blockchain/scripts/sim.ts` |
| Hire agents from Claude | The MCP server's tools: `find_agent`, `get_quote`, `hire_agent`, `tender_job`, `list_rounds`, `join_group_buy`, `check_balance`, `get_job`, `hire_studio` | `Blockchain/mcp/src/index.ts`; config in the README's MCP section |

## 4. What is real, and what is a stand-in

- **Real:** every round step, IOU verification, netting, collateral, settlement and default runs on chain (testnet, or the local sandbox). Every number on the site comes from the ledger and the chain. The research agents call real services (Wikipedia, MyMemory). Studio deliverables are produced by code you can read and test.
- **intents-lite instead of `intents.near`.** NEAR Intents is on mainnet only and this project has no mainnet budget, so settlement goes through a small contract with the same `execute_intents` interface and NEP-413 payload rules. The site labels it wherever it names the verifier. Switching to `intents.near` is one setting (`QUORUM_INTENTS_CONTRACT`).
- **Test USDC** (open faucet) instead of real USDC. Sign-in accepts mainnet accounts, but only testnet test USDC moves.
- **GPU hours are simulated.** Market sellers deliver a signed receipt marked `simulated: true`.
- **Bidding is scripted**, never a model: five seeded strategies, as the track's simulation mode asks.
- **The model is optional.** Quill (brand copy) and Scribe (summaries) use NEAR AI Cloud only when `NEAR_AI_API_KEY` is set. Without it they use their rule-based writers, and each result records which engine wrote it. A local run, and any deployment without a key, shows **Template writer**.
- **Studio work is mostly templates and procedural code**: three contract templates, a few logo motifs, and a small animated GIF instead of a video.

## 5. How it maps to the tracks

| AI Swarms asks for | Where |
|---|---|
| Coordination markets and bidding | Sealed-bid tenders and group buys, decided by the contract (`rounds.rs`) |
| Collective purchasing | Group buys: buyers pool demand and each pays its share |
| Intent-based settlement | Net debts settle as signed NEAR Intents `transfer`s in one batch |
| Emergent economies between agents | 50 agents in three swarms; team leads hire freelancers, research agents hire each other, prices move with the strategies (see the price chart on `/rounds`) |
| Sub-accounts | One per agent, created by its operator, registered from the agent's own key |

| Agent Economy asks for | Where |
|---|---|
| Agents that earn, spend and hire other agents | Every hire is a priced job; team leads earn a commission and pay their team |
| Paying for APIs, compute or data | Research agents buy search, translation and chart reading from each other; buyers lease (simulated) GPU hours |
| Payments through NEAR Intents | Every epoch settles through `execute_intents` |
| A human in control | The wallet-signed spending limit: budget, per-job cap, deadline |

## 6. If something does not run

- `node:sqlite` not found → Node is older than 22.13. Check `node -v`.
- `pnpm dev` or `pnpm sim` hangs at the node on Windows → run the node in WSL (`pnpm chain` in WSL, `pnpm dev` in Windows), as the README shows.
- The swarm takes about 90 s to fund its accounts before `[fleet] ready`; pages fill in after that.
- `test:contracts` and `test:forge` need Rust (`rustup`, plus the `wasm32-unknown-unknown` target for forge).
