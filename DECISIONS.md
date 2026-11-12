# Design decisions

Each decision records what we chose, what we gave up, and why. The rules themselves are in [RULES.md](RULES.md).

## 1. One coordinator contract

The registry, collateral, rounds, epochs and reputation all live in one Rust contract instead of being split across several.

**Why:** netting has to read identities, lock collateral and record positions in one atomic step. On NEAR a cross-contract call is a separate receipt: it runs later, and a failure in the callee does not roll back the caller. Keeping identity, collateral, rounds, positions and reputation in one contract keeps every check synchronous.

## 2. NEP-413 for every message, with a deterministic nonce

Quotes, IOUs, deliveries, intents, disputes and verdicts are canonical JSON signed under NEP-413. The recipient is the coordinator contract, and the nonce is `sha256(message)`.

**Why:**
- NEP-413 is what NEAR wallets sign and what the NEAR Intents verifier accepts.
- Binding the recipient makes a signature useless on any other deployment.
- A deterministic nonce lets the contract rebuild the signed bytes from the IOU fields alone, so the clearer cannot hand it a nonce that changes what was signed.
- ed25519 cannot recover a signer from a signature, so every agent registers its key and every check is "this key belongs to this agent".

## 3. The contract fills in the token and the recipient

An IOU posted to the contract carries no token and no contract id. The contract inserts its own when it rebuilds the message.

**Why:** an IOU signed for another token or another deployment then fails verification by construction, with no extra check to forget.

## 4. Commit-reveal rounds, decided on chain

Sellers post `sha256(domain ‖ round ‖ seller ‖ price ‖ salt)` and reveal later. Anyone may close the round. The winner and the price follow from the revealed bids alone.

**Why:**
- A sealed bid is only sealed if nobody, the operator included, can read it before bidding closes.
- Deciding on chain means the clearing service has no say in who wins.
- Second price is the default because bidding your true cost is then each seller's best strategy, which keeps the scripted market honest.
- Ties go to the earlier commitment, so the result is fully determined.

## 5. Group buys charge each buyer quantity × price

Buyers whose limit is under the clearing price drop out and pay nothing. Everyone else pays exactly their own quantity times the one clearing price.

**Why:** that is what the track's group-buying example asks for (each buyer pays only its share), and it makes the bill checkable: the shares always add up to price × total quantity.

## 6. A round binds the purchase that follows it

A job whose specification names a round must be bought from the round's winner at exactly the allocation's cost, once per buyer. The seller's quote reads the price from the chain.

**Why:** otherwise a round could pick a winner and the buyer could still pay anyone anything. The clearing service enforces it at IOU intake, and the evidence chain shows the round next to the IOU.

## 7. Settlement pays creditors directly, from a plan fixed by the contract

At finalisation the contract computes the settlement plan: walk debtors and creditors in first-appearance order and pay `min(remaining debt, remaining claim)` at each step.

**Why:**
- That is at most `debtors + creditors − 1` transfers, with no pool contract holding money in between.
- Fixing the plan on chain lets `settle` accept a NEAR Intents payload only if it matches the plan line for line.
- The TypeScript mirror must produce the same plan hash for every epoch.

## 8. The verifier executes the batch; the contract only checks and records

`settle` checks each debtor's signed `transfer` intents and forwards the whole batch to `execute_intents`. It marks debtors settled only in the callback, and only if the verifier executed the batch.

**Why:**
- The money never passes through Quorum's contract: it moves inside the verifier, between the agents' own balances.
- A batch is atomic, so either every listed debt is paid or none is.
- The settlement nonce is derived from (contract, epoch, agent), so the verifier itself refuses to pay one debt twice.

## 9. intents-lite where intents.near does not exist

NEAR Intents is deployed on mainnet only, and this project has no mainnet budget. Local sandboxes and testnet therefore run `intents-lite`: the same `execute_intents` entry point, NEP-413 payloads, `nep141:` token ids, deposits by `ft_transfer_call` with the receiver in `msg`, public-key registration and nonce replay protection.

**Why not mock it in the service?** Because then the settlement path would be fake. With intents-lite, the contract-to-verifier call and the batch semantics are real on chain. Moving to mainnet means setting `QUORUM_INTENTS_CONTRACT=intents.near` and a real token. The website and README say plainly which verifier a deployment uses.

## 10. Defaults are paid into the verifier

A debtor that misses the deadline has its locked collateral seized. The contract deposits it, by `ft_transfer_call`, into the verifier for exactly the creditors that debtor's plan lines name.

**Why:** creditors end up with the same balance, in the same place, as if the debtor had paid.

## 11. Integer agent ids next to account names

Every agent has a NEAR account and a numeric id assigned at registration.

**Why:**
- IOUs are posted in (buyer, nonce) order and keyed as `(buyer << 64) | nonce`, so a fixed-width id keeps that ordering and the commitment hashes simple.
- The ledger, the netting code and the hash chains all key on integer ids.

## 12. Every agent is a sub-account of one root

The operator account creates `name.root` for each agent with a key derived from a master seed and the name. The agent registers and acts from that account.

**Why:**
- The track asks that every on-chain action trace to a specific agent.
- Deriving keys from one seed means a deployment is described by two secrets (the seed and the root key), and a restarted swarm finds its accounts again.

## 13. Pruning old state

Sealed epochs and closed rounds older than ten minutes can be removed from contract state by the clearer. The clearing service keeps the latest 20 epochs and 40 rounds on chain on public networks.

**Why:** NEAR charges storage by locking NEAR, and an always-on swarm writes a round or an epoch every minute. The ledger, the Supabase mirror and the chain's transaction history keep everything; contract state only needs what is still live or recent.

## 14. A bounded wait for every transaction

The NEAR client resends an identical signed transaction when the network fails before the node answers. It waits at most a minute for a transaction it could not confirm, then resets its nonce and fails.

**Why:** we saw a dropped connection leave one transaction unconfirmed and block every later write from the same account for many minutes. Resending the same bytes is safe because the node identifies a transaction by its hash. The bounded wait turns a stall into a retry.

## 15. Scripted bidding strategies, seeded

The market's sellers use five fixed strategies (cost-plus, undercutter, adaptive, opportunist, noisy), and buyers' demand comes from a seeded generator. No model is called.

**Why:**
- The track asks for a simulation mode with scripted strategies and no LLM calls.
- A seed makes a run reproducible, so `pnpm sim` can be checked by anyone and produces the same rounds again.
- Price discovery still emerges: the adaptive and undercutting sellers learn from past clearing prices and pull the price down over the rounds.

## 16. The research agents do real work

Search reads live Wikipedia, translation uses MyMemory, and summaries, chart descriptions and the validator's re-checks run real code. Each has an offline fallback, labelled as such.

**Why:** a market of agents is only interesting if what they sell is real. The GPU market is the one exception: real GPU leases are out of scope, so those deliveries say `simulated: true`.
