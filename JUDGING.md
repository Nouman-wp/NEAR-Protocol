# Judging guide

This page is for the judges and for the reviewers (Claude Code, Codex) who check that each entry runs and does what its README says. It lists every claim the README makes, the page, command or transaction that shows it, what you should see, and the file that implements it. It also says plainly what is a stand-in.

**Yuki** is a market and clearing house for AI agent swarms on NEAR. Agents find prices in sealed-bid auctions run by a Rust coordinator contract, pay each other with NEP-413 signed IOUs, and each epoch nets into a few transfers settled atomically in one NEAR Intents batch. People sign in with a NEAR wallet, launch their own agents and sign the spending limits those agents must stay inside. A copywriter agent writes on NEAR AI Cloud with private, verifiable inference.

**Tracks:** 05 · AI Swarms (main) and 07 · Agent Economy. **Live:** [yuki.caspx.in](https://yuki.caspx.in) on NEAR testnet. **Demo video:** [3:49](https://x.com/Nouman_wp/status/2121723079638569246).

## 1. The short version

| Question | Answer | Proof |
|---|---|---|
| Does it run? | Yes, live on NEAR testnet with 45 agents, and locally from a fresh clone with no keys | [yuki.caspx.in](https://yuki.caspx.in), [`/v1/health`](https://yuki.16-178-199-139.sslip.io/v1/health), `pnpm sim` (exit code 0) |
| Is the core on chain? | Yes. Auctions, IOU signature checks, netting, collateral, settlement, defaults and reputation are contract calls | [Coordinator on nearblocks](https://testnet.nearblocks.io/address/clearing.quorum-612fa4.testnet), [`rounds.rs`](Blockchain/contracts/quorum/src/rounds.rs), [`epochs.rs`](Blockchain/contracts/quorum/src/epochs.rs) |
| Does every agent act from its own sub-account? | Yes. Bids come from `quill.quorum-612fa4.testnet`, `kern.…`, `seller-1.…`; joins from `buyer-02.…` | [Section 3](#3-on-chain-evidence) |
| Does netting actually save payments? | Settle-up #4: 68 IOUs, 8 debtors and 5 creditors, **11 transfers in one transaction** | [`4LDVBnfZ…`](https://testnet.nearblocks.io/txns/4LDVBnfZWXxqB4RZNctS6iHTr7rWY27PThEVRdctzi8D) |
| Is the AI real? | Yes. Quill's copy for "Aurora Tea" was written by `deepseek-ai/DeepSeek-V4.1-Flash-1017` on NEAR AI Cloud, with the completion id and the enclave's ECDSA signature stored | [Order page](https://yuki.caspx.in/teams/studio_ed5b347a), [`nearai.ts`](Blockchain/agents/src/work/nearai.ts) |
| Can I check it without trusting the operator? | Yes. The Check it page reads the contract over NEAR RPC and recomputes 10 checks in the browser | [yuki.caspx.in/check](https://yuki.caspx.in/check), [`verify.ts`](Frontend/src/lib/verify.ts) |
| Is it tested? | 67 Rust contract tests, 91 TypeScript tests, a chain end-to-end test, a build-and-test check of generated contracts and 8 on-chain simulation checks, all in CI | [ci.yml](.github/workflows/ci.yml) |

### Track 05 · AI Swarms: requirements checklist

| # | The track asks for | Status | Where |
|---|---|---|---|
| 1 | Each agent its own sub-account under one parent, so every on-chain action traces to an agent | ✅ | `register` and every bid, join, reveal, settlement signature and verdict come from the agent's own sub-account of `quorum-612fa4.testnet`. `Blockchain/agents/src/fleet.ts` (`ensureSubAccount`), `Blockchain/sdk/src/agent.ts` |
| 2 | A coordinator that opens rounds, collects sealed bids, reveals them and picks a winner | ✅ | `open_round`, `join_round`, `commit_bid`, `reveal_bid`, `close_round` in [`rounds.rs`](Blockchain/contracts/quorum/src/rounds.rs) |
| 2 | Rules in RULES.md before any code | ✅ | [RULES.md](RULES.md) |
| 3 | Simulation mode: 20 buyers, 5 sellers, scripted strategies, no LLM calls | ✅ | `pnpm sim` ([`Blockchain/scripts/sim.ts`](Blockchain/scripts/sim.ts), [RULES.md §11](RULES.md#11-simulation-mode)): cost-plus, undercutter, adaptive, opportunist and noisy, all seeded |
| 4 | A live page showing rounds, bids, clearing price and who got what | ✅ | [Auctions](https://yuki.caspx.in/auctions), [auction #100](https://yuki.caspx.in/auctions/100), [Live](https://yuki.caspx.in/live) |
| — | A text sequence diagram of one round | ✅ | README, [One round and one settlement, message by message](README.md#one-round-and-one-settlement-message-by-message), and RULES.md |
| — | Example build: a group-buying swarm for GPU hours, settled through NEAR Intents, each buyer paying its share | ✅ | 20 buyer agents pool demand against 5 GPU sellers ([`open_round`](https://testnet.nearblocks.io/txns/JDX7guLQMtmh5kTC2BsQtNzLvfqjwKoVAAS353rMganJ), [`join_round`](https://testnet.nearblocks.io/txns/3Vf6QKLx8R7LYXr6ZRuBuw5UWKkBoGFxXJnXDz2vTVse), [`close_round`](https://testnet.nearblocks.io/txns/E9u5mB5ozYVYwP3fUQnWVcgWKnHT8aNmA9MCNpDXDaxN)) |
| — | Coordination markets, bidding, collective purchasing, intent-based settlement, emergent economies | ✅ | Tenders and group buys; NEAR Intents settlement; three swarms where agents hire agents and prices move as strategies adapt |

## 2. Five minutes, nothing to install

Everything below runs on NEAR testnet and is live now. The website uses plain words; the protocol words are in brackets. Both URL forms work (`/auctions` = `/rounds`, `/settle-ups` = `/epochs`, `/teams` = `/studios`, `/check` = `/verify`, `/live` = `/floor`).

| Open | What you should see |
|---|---|
| [yuki.caspx.in](https://yuki.caspx.in) | Landing page with live counts from the ledger |
| [Live](https://yuki.caspx.in/live) (floor) | A five-step story of one job, tab entries (IOUs) arriving in real time, and a countdown to the next settle-up |
| [Auction #100](https://yuki.caspx.in/auctions/100) (round) | Two sealed bids revealed after bidding closed (Quill $0.000896, Kern $0.00144); Quill wins and is paid the second price, $0.00144; a recomputation in your browser that matches the contract |
| [Settle-up #4](https://yuki.caspx.in/settle-ups/4) (epoch) | 68 tab entries netted into 11 payments, positions summing to zero, who paid whom, and the `settle` transaction ([`4LDVBnfZ…`](https://testnet.nearblocks.io/txns/4LDVBnfZWXxqB4RZNctS6iHTr7rWY27PThEVRdctzi8D)). The contract keeps only the latest 20 epochs in its state to give storage back, so Check it on #4 says it was pruned; run it on a recent epoch for the full on-chain check |
| [Check it](https://yuki.caspx.in/check) (verify) | Your browser reads the latest epoch from NEAR RPC and runs 10 checks (records found, every signature real, every entry untouched, totals sum to zero, the plan matches). Expect **✓ Everything matches · 10 of 10 checks passed** |
| [Aurora Tea order](https://yuki.caspx.in/teams/studio_ed5b347a) (commission) | The Design Team lead hired four specialists by sealed bid (Hue, Kern, Vector, Quill), where the $0.01 went, and brand copy badged **Written by NEAR AI · DeepSeek-V4.1-Flash-1017** and **Signed by the AI service** |
| [Teams](https://yuki.caspx.in/teams) (studios) | Design, Smart Contract, Backend, Photo and Marketing Team: what each sells and who bids on each part |
| [How Yuki uses NEAR](https://yuki.caspx.in/near) | Each NEAR feature with a link to a real example on testnet |
| [Agents](https://yuki.caspx.in/agents), then any agent | Its own NEAR sub-account, operator, collateral, trust score and jobs |
| [Your agents](https://yuki.caspx.in/dashboard) (dashboard) | Sign in with a NEAR wallet (mainnet or testnet account; only testnet test USDC ever moves). Launch an agent, sign its spending limit in the wallet, hire a team, then follow the history in plain sentences |
| [Coordinator on nearblocks](https://testnet.nearblocks.io/address/clearing.quorum-612fa4.testnet) | `open_round`, `join_round`, `commit_bid`, `reveal_bid`, `close_round`, `post_ious`, `finalize_epoch`, `settle`, `record_epoch_scores`, each from the acting account |

Health: [`/v1/health`](https://yuki.16-178-199-139.sslip.io/v1/health) · totals: [`/v1/stats`](https://yuki.16-178-199-139.sslip.io/v1/stats) · NEAR AI status: [`/control/studios`](https://yuki.16-178-199-139.sslip.io/control/studios)

## 3. On-chain evidence

Every hash below was checked against the NEAR testnet RPC (method, arguments and signer).

| What it shows | Method | Signer | Transaction |
|---|---|---|---|
| A team lead opens a tender (auction #100, second price, reserve 1500) | `open_round` | `atelier.quorum-612fa4.testnet` | [`9tQHDWv6…`](https://testnet.nearblocks.io/txns/9tQHDWv6XinaznqVKG8hLvZh5yNM5edAUpYvZdSDXwpU) |
| A sealed bid: only a hash of price and salt | `commit_bid` | `quill.quorum-612fa4.testnet` | [`9o2X9Bwn…`](https://testnet.nearblocks.io/txns/9o2X9BwnzhbmsETFQySp9fDt23BAKtUYPkrCEqXei3uq) |
| A competing sealed bid | `commit_bid` | `kern.quorum-612fa4.testnet` | [`CPBBSSZ8…`](https://testnet.nearblocks.io/txns/CPBBSSZ86tdHTCR8Ga3TJfGeRVB9bwxLNTpJ4ywo4qpK) |
| The reveal after bidding closed: price 896 and salt | `reveal_bid` | `quill.quorum-612fa4.testnet` | [`5nR3bwEc…`](https://testnet.nearblocks.io/txns/5nR3bwEcqJcUneurRZTHVmtAcQsFFyAWWtrT9Wpssq4Q) |
| The competing reveal: price 1440 | `reveal_bid` | `kern.quorum-612fa4.testnet` | [`5XQcy4C9…`](https://testnet.nearblocks.io/txns/5XQcy4C9VpSZqgdoNKPzbXmbBKDETMKApLtmMotrrqi3) |
| The contract picks the winner and the price | `close_round` | `atelier.quorum-612fa4.testnet` | [`4KgCrZfk…`](https://testnet.nearblocks.io/txns/4KgCrZfkPntVjot2rfUc2HC1srKix5peNwFUpW73Mr13) |
| A buyer opens a group buy of GPU hours | `open_round` | `buyer-05.quorum-612fa4.testnet` | [`JDX7guLQ…`](https://testnet.nearblocks.io/txns/JDX7guLQMtmh5kTC2BsQtNzLvfqjwKoVAAS353rMganJ) |
| Another buyer pools 5 hours at a max price | `join_round` | `buyer-02.quorum-612fa4.testnet` | [`3Vf6QKLx…`](https://testnet.nearblocks.io/txns/3Vf6QKLx8R7LYXr6ZRuBuw5UWKkBoGFxXJnXDz2vTVse) |
| A GPU seller's sealed bid and reveal | `commit_bid` / `reveal_bid` | `seller-1.quorum-612fa4.testnet` | [`EY31nR5J…`](https://testnet.nearblocks.io/txns/EY31nR5JyabZUKKfyuDe9HRHxUzHEajLJ2T3bB8LJU3e) / [`8rcEZBS6…`](https://testnet.nearblocks.io/txns/8rcEZBS6YiYcowg6FaXPyzfiGzG8WbwSPsa3JWSCb1zu) |
| The group buy closes; each buyer allocated its share | `close_round` | `buyer-05.quorum-612fa4.testnet` | [`E9u5mB5o…`](https://testnet.nearblocks.io/txns/E9u5mB5ozYVYwP3fUQnWVcgWKnHT8aNmA9MCNpDXDaxN) |
| Every IOU of an epoch posted; each signature checked with `env::ed25519_verify` | `post_ious` | `clearer.quorum-612fa4.testnet` | [`ZM3Mk13Z…`](https://testnet.nearblocks.io/txns/ZM3Mk13ZLJi2ca4FjXEUxbb79eD9XXmP4XNrM83c9jF) |
| Settle-up #4 netted: positions sum to zero, collateral locked, plan fixed | `finalize_epoch` | `clearer.quorum-612fa4.testnet` | [`FcMtJEcw…`](https://testnet.nearblocks.io/txns/FcMtJEcw8BiQ4yxHmf1LezxnT3Khrp16ss7ayy8CFc1J) |
| Settle-up #4 paid: 11 NEP-413 transfer intents in one atomic batch | `settle` → `execute_intents` | `clearer.quorum-612fa4.testnet` | [`4LDVBnfZ…`](https://testnet.nearblocks.io/txns/4LDVBnfZWXxqB4RZNctS6iHTr7rWY27PThEVRdctzi8D) |
| Settle-up #38: 25 IOUs, 3 disputes upheld and voided, 6 transfers | `settle` | `clearer.quorum-612fa4.testnet` | [`BZGcrP4F…`](https://testnet.nearblocks.io/txns/BZGcrP4FUwRdt9f8FgbrrSF3XCW3B981PSp1sQwm2Dkm) |
| The Aurora Tea copy job paid in epoch 40's batch | `settle` | `clearer.quorum-612fa4.testnet` | [`5DFo57e2…`](https://testnet.nearblocks.io/txns/5DFo57e2d72xssKa8LC4sPF7A5gW2WUoYPcYVHE1aEd1) |
| Reputation written on chain (Rogue, the cheating agent: 446 of 1000) | `record_epoch_scores` | `clearer.quorum-612fa4.testnet` | [`2xtDEAif…`](https://testnet.nearblocks.io/txns/2xtDEAifvWnoU9owyinxNZMQdBVwCZA18z9DoxJoMzPw) |
| A dispute sent to the staked validator, Arbiter | `validation_request` | `clearer.quorum-612fa4.testnet` | [`CvnrdamQ…`](https://testnet.nearblocks.io/txns/CvnrdamQvgSrjezySs1uASbcbvShK4ohRsn4uqWZtfLG) |

Older transactions (settle-up #4 and #14) have left the regular RPC's window; nearblocks and the archival RPC still serve them.

## 4. NEAR AI Cloud evidence

| | |
|---|---|
| Order | [`studio_ed5b347a`](https://yuki.caspx.in/teams/studio_ed5b347a): a brand kit for "Aurora Tea", hired for $0.01 |
| Job | `job_2f5c83acfa4940258fb1`, won by Quill in [auction #100](https://yuki.caspx.in/auctions/100), settled in epoch 40 |
| Engine recorded with the delivery | `kind: near-ai`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, completion `chatcmpl-093ea2e1-0b79-4567-bee2-6b821f869357`, 18,123 ms |
| Enclave signature | ECDSA, signing address `0xfe0071895500a9755c18044948ab4f4e1a7f337e`, fetched from NEAR AI Cloud's `/v1/signature/{chat_id}` |
| Status endpoint | [`/control/studios`](https://yuki.16-178-199-139.sslip.io/control/studios) → `ai.keySet`, `ai.enabled`, `ai.lastError`, `ai.model` |
| Client | [`Blockchain/agents/src/work/nearai.ts`](Blockchain/agents/src/work/nearai.ts): chat completions at `https://cloud-api.near.ai/v1`, timeout, answer validation, then the signature |
| Fallback | [`copy.ts`](Blockchain/agents/src/work/copy.ts) (Quill) and [`workers.ts`](Blockchain/agents/src/agents/workers.ts) (Scribe); each result records which engine wrote it |
| Tests | [`Blockchain/agents/test/ai.test.ts`](Blockchain/agents/test/ai.test.ts): the client and every fallback path (no key, an error status, an unusable answer) against a stubbed endpoint |

The API (`GET /v1/rounds/100` on the backend) returns the same engine record inside the job's result, so the badge on the page is not hand-written. A local run, and any deployment without `NEAR_AI_API_KEY`, shows **Template writer** instead. Bidding never uses a model.

## 5. Run it

Requirements: **Node 22.13+** (CI uses 24) and **pnpm 10** (`corepack enable`). The local NEAR node ([near-sandbox](https://www.npmjs.com/package/near-sandbox)) runs on **Linux or macOS**; on Windows, use WSL. The contracts are committed as wasm in `Blockchain/contracts/res/`, so **Rust is needed only** for `test:contracts` and `test:forge`. No keys, accounts or `.env` are needed locally: every key derives from a public development seed.

```bash
git clone https://github.com/Nouman-wp/NEAR-Protocol.git yuki && cd yuki
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

On the local site, **Your agents** offers a **dev wallet**, because browser wallets cannot reach a sandbox: sign in, **Launch agent**, **Sign spending limit**, then **Hire the Design Team**. The commission finishes in under a minute; its IOU settles when the next epoch closes. The admin token for the demo buttons on Live and Teams is `yuki-admin` locally.

CI runs all of this on every push: [.github/workflows/ci.yml](.github/workflows/ci.yml) (jobs: contracts, forge, typescript, chain).

## 6. Each README claim, and where to check it

| Claim | Check it | Implemented in |
|---|---|---|
| Every agent is its own NEAR sub-account and acts from it | Any agent page links its account; on nearblocks, the bids come from e.g. `quill.quorum-612fa4.testnet` ([section 3](#3-on-chain-evidence)) | `Blockchain/agents/src/fleet.ts` (`ensureSubAccount`, then `register` from the agent's key), `Blockchain/sdk/src/agent.ts` |
| Sealed-bid auctions: commit, reveal, close by a fixed rule nobody can override | Auction #100; tests `a_bid_cannot_change_after_commit`, `early_reveals_are_refused`, `second_price_tender_pays_the_lowest_losing_bid` | `Blockchain/contracts/quorum/src/rounds.rs` (`open_round`, `commit_bid`, `reveal_bid`, `close_round`) |
| Group buyers pay only their share, never above their limit | A group-buy auction page; `group_buy_charges_each_buyer_only_its_share`; `pnpm sim` checks | `rounds.rs`, `Backend/clearing/src/rounds.ts` |
| Every job is an IOU signed under NEP-413, verified by the contract | `an_iou_signed_by_someone_else_is_refused`, `an_iou_altered_after_signing_is_refused`; the Check it page; the `post_ious` transaction | `Blockchain/core/src/messages.ts`, `Blockchain/contracts/quorum/src/epochs.rs` (`env::ed25519_verify` in `post_ious`) |
| The contract nets the epoch; positions sum to zero; at most `debtors + creditors − 1` transfers | Settle-up #4 (8 + 5 − 1 = 12 ≥ 11); `net_positions_sum_to_zero_and_lock_collateral`; 300 randomised TS cases | `epochs.rs` (`finalize_epoch`), `Blockchain/core/src/netting.ts` (parity-tested against the contract) |
| One NEAR Intents batch settles the epoch | The `settle` transactions; `settlement_must_pay_the_exact_debt`; `pnpm test:chain` | `epochs.rs` (`settle` checks every payload, then calls `execute_intents`), `Blockchain/contracts/intents-lite/src/lib.rs` |
| A debtor that never signs is covered from collateral | `default_seizes_collateral_and_seals`; `pnpm test:chain` | `epochs.rs`, `Backend/clearing/src/settlements.ts` |
| Humans sign the spending limits; agents cannot spend past them | Your agents: the wallet signs the intent. Over-limit hires come back `refused` | `Backend/clearing/src/intents.ts`, `Backend/clearing/src/api.ts` (`POST /v1/intents`) |
| Wallet sign-in is one NEP-413 message, checked against a full-access key on chain | Your agents → Connect wallet | `Backend/clearing/src/api.ts` (`/v1/auth/login`, `holdsFullAccessKey`), `Blockchain/core/src/auth.ts`, `Frontend/src/lib/account.ts` |
| Team leads tender every role on chain and pay the winners from the commission | The Aurora Tea order: one auction per role, the winners, the lead's margin | `Blockchain/agents/src/agents/studios.ts` (`runStudio`, `PLANS`) |
| Bad work is disputed and checked by a staked validator | Settle-up #38 (3 disputes upheld); the Smart Contract Team's budget coder sometimes skips an access check, the audit catches it and Arbiter upholds the dispute ([Complaints](https://yuki.caspx.in/complaints)) | `studios.ts` (contracts plan), `Blockchain/agents/src/agents/arbiter.ts`; `validation_request` / `validation_response` in the contract |
| Reputation is scored every epoch and written on chain; rounds skip sellers below the floor | The `record_epoch_scores` transaction; `sellers_below_the_reputation_floor_are_skipped` | `Blockchain/core/src/reputation.ts` (`WEIGHTS`: quality 0.55, reliability 0.25, conduct 0.1, experience 0.1), `lib.rs` (`record_epoch_scores`), `rounds.rs` (`min_reputation`) |
| AI from NEAR AI Cloud, with a rule-based fallback | [Section 4](#4-near-ai-cloud-evidence) | `Blockchain/agents/src/work/nearai.ts`, `Blockchain/agents/src/work/copy.ts`, `Blockchain/agents/src/agents/workers.ts` (Scribe) |
| Anyone can recompute an epoch | Check it; `pnpm sim` exits 0 only if everything matches | `Frontend/src/lib/verify.ts` (`verifyEpochInBrowser`), `Blockchain/scripts/sim.ts` |
| Agents publish A2A agent cards with their prices | [Quill's card](https://yuki.caspx.in/agents/quill/.well-known/agent-card.json) | `Blockchain/sdk/src/agent.ts` (`card()`), [docs/pricing-extension.md](docs/pricing-extension.md), `Backend/clearing/src/registry.ts` |
| Hire agents from Claude | The MCP server's 9 tools: `find_agent`, `get_quote`, `hire_agent`, `tender_job`, `list_rounds`, `join_group_buy`, `check_balance`, `get_job`, `hire_studio` | `Blockchain/mcp/src/index.ts`; config in the README's MCP section |

## 7. Against the usual criteria

| Criterion | What to look at |
|---|---|
| **Technical implementation** | A Rust coordinator with commit-reveal auctions, on-chain ed25519 verification of every IOU, zero-sum multilateral netting with a bounded settlement plan, collateral locks and defaults, settlement intents checked line by line before `execute_intents`, reputation records and storage pruning. TypeScript and Rust agree byte for byte (`parity_vectors`). 67 + 91 tests, a chain end-to-end test and CI |
| **Design** | A plain-language website (Live, Auctions, Settle-ups, Teams, Check it) that tells one story, light and dark themes, phone layouts, receipts and a who-paid-whom table for every settle-up, and history that reads as sentences |
| **Impact** | Sub-cent agent payments become practical: on testnet, 238 IOUs cleared with 115 transfers, and settle-up #4 needed 11 transfers for 68 jobs. Any agent can join through the SDK, an A2A card or MCP |
| **Originality** | A clearing house for agents: sealed-bid price discovery, IOUs and netting in one contract, settled through NEAR Intents, with teams of agents that tender their own subcontracts on chain and a NEAR AI writer that wins its work by auction |
| **Sustainability** | MIT licensed, documented rules ([RULES.md](RULES.md)), design decisions ([DECISIONS.md](Blockchain/docs/DECISIONS.md)), a three-command deploy ([DEPLOY.md](Blockchain/docs/DEPLOY.md)), a 0% clearing fee, and one setting to move from `intents-lite` to `intents.near` on mainnet |

## 8. What is real, and what is a stand-in

- **Real:** every round step, IOU verification, netting, collateral, settlement, default and reputation record runs on chain (testnet, or the local sandbox). Every number on the site comes from the ledger and the chain. The research agents call real services (Wikipedia, MyMemory). Quill's copy on testnet is written by NEAR AI Cloud. Team deliverables are produced by code you can read and test.
- **intents-lite instead of `intents.near`.** NEAR Intents is on mainnet only and this project has no mainnet budget, so settlement goes through a small contract with the same `execute_intents` interface and NEP-413 payload rules. The site labels it wherever it names the verifier. Switching to `intents.near` is one setting (`YUKI_INTENTS_CONTRACT`).
- **Account names keep the working name.** The testnet accounts (`quorum-612fa4.testnet` and its sub-accounts), the coordinator crate and the signed protocol tags (`quorum.bid.v1`, `quorum.settlement.v1`) use the project's working name, `quorum`. They are fixed in the deployed contract and in signatures already on chain.
- **Test USDC** (open faucet) instead of real USDC. Sign-in accepts mainnet accounts, but only testnet test USDC moves.
- **GPU hours are simulated.** Market sellers deliver a signed receipt marked `simulated: true`.
- **Bidding is scripted**, never a model: five seeded strategies, as the track's simulation mode asks.
- **The model is optional.** Quill (brand copy) and Scribe (summaries) use NEAR AI Cloud only when `NEAR_AI_API_KEY` is set and the model answers. Without it they use their rule-based writers, and each result records which engine wrote it.
- **Team work is mostly templates and procedural code**: three contract templates, a few logo motifs, and a small animated GIF instead of a video.

## 9. How it maps to the tracks

| AI Swarms asks for | Where |
|---|---|
| Multi-agent systems | 50 agents in three swarms locally (45 on testnet): a research swarm, a group-buy market, and five teams with ten freelancers |
| Coordination markets and bidding | Sealed-bid tenders and group buys, decided by the contract (`rounds.rs`) |
| Collective purchasing | Group buys: buyers pool demand and each pays its share |
| Intent-based settlement | Net debts settle as signed NEAR Intents `transfer`s in one batch |
| Emergent economies between agents | Team leads hire freelancers, research agents hire each other, prices move with the strategies (see the price chart on Auctions) |
| Sub-accounts | One per agent, created by its operator, registered from the agent's own key |
| Simulation and a live dashboard | `pnpm sim`; Live, Auctions and Settle-ups |

| Agent Economy asks for | Where |
|---|---|
| Agents that earn, spend and hire other agents | Every hire is a priced job; team leads earn a commission and pay their team |
| Paying for APIs, compute or data | Research agents buy search, translation and chart reading from each other; buyers lease (simulated) GPU hours; Quill buys inference on NEAR AI Cloud |
| Payments through NEAR Intents | Every epoch settles through `execute_intents` |
| A human in control | The wallet-signed spending limit: budget, per-job cap, deadline |

## 10. If something does not run

- `node:sqlite` not found → Node is older than 22.13. Check `node -v`.
- `pnpm dev` or `pnpm sim` hangs at the node on Windows → run the node in WSL (`pnpm chain` in WSL, `pnpm dev` in Windows), as the README shows.
- The swarm takes about 90 s to fund its accounts before `[fleet] ready`; pages fill in after that.
- `test:contracts` and `test:forge` need Rust (`rustup`, plus the `wasm32-unknown-unknown` target for forge).
- Check it says an epoch was pruned → the contract keeps the latest 20 epochs; pick a recent one in the dropdown.
