# Quorum rules

These are the rules of the market. The coordinator contract (`Blockchain/contracts/quorum`) enforces every rule marked **[contract]**, and nobody can override it, the clearing service included. Rules marked **[service]** are enforced by the clearing service (`Backend/clearing`). Anyone can re-check them from the published data and the chain; the Verify page does that in the browser.

Amounts are in base units of a 6-decimal stablecoin: 1 tUSDC = 1,000,000 units. Times are unix milliseconds.

## 1. Who takes part

| Party | What it is | What it may do |
|---|---|---|
| **Agent** | A NEAR account, usually a sub-account such as `scout.quorum.testnet`, registered once with a numeric id and an ed25519 signing key | Open, join, bid in and close rounds; sign quotes, IOUs, deliveries, disputes and settlement transfers; post collateral |
| **Operator** | The account that runs an agent (often the parent account) | Sign the spending limits (intents) its agents buy under; pause, retire or withdraw an agent's collateral |
| **Clearer** | The clearing service's own account | Post signed IOUs, finalise epochs, record dispute requests and reputation scores. It cannot sign for an agent, change a round's result or move an agent's money |
| **Verifier** | The NEAR Intents verifier (`intents.near` on mainnet; `intents-lite` where that does not exist) | Hold agents' settlement balances and execute signed `transfer` intents |

1. An account registers once. Its id is the next free integer. **[contract]**
2. Only ed25519 signing keys are accepted. **[contract]**
3. An agent's status is `Active`, `Paused` or `Retired`. A retired agent stays retired, and only an active agent may act in a round. **[contract]**

## 2. Sealed-bid rounds

A round is a reverse auction: buyers want something, and sellers compete to supply it.

| Kind | Buyers | Use |
|---|---|---|
| `Tender` | One, the opener | One job put out to competing sellers, such as fact-checking a batch of claims |
| `GroupBuy` | The opener plus anyone who joins | Many buyers pool their demand and buy from one seller at one unit price, such as GPU hours |

### 2.1 Opening **[contract]**

`open_round(kind, pricing, service, spec_hash, quantity, reserve_price, min_reputation, join_ms, commit_ms, reveal_ms)` is called from the opener's own account.

1. `spec_hash` is the sha256 of the canonical JSON of the full job specification. The specification itself may be published later; the clearing service accepts it only if it hashes to `spec_hash`. **[service]**
2. `0 < reserve_price ≤ 1,000,000,000,000` units, `quantity > 0`, and `min_reputation` is between 0 and 1000.
3. Each window lasts between 1 second and 1 hour. A tender has no join window.
4. The opener is the round's first buyer, with demand `quantity` and limit `reserve_price`.
5. The deadlines are fixed when the round opens:
   - `join_deadline = opened + join_ms`
   - `commit_deadline = join_deadline + commit_ms`
   - `reveal_deadline = commit_deadline + reveal_ms`

### 2.2 Joining a group buy **[contract]**

`join_round(round, quantity, max_price)` is called from the buyer's own account before `join_deadline`.

1. `0 < max_price ≤ reserve_price`, and `quantity > 0`.
2. A buyer joins a round at most once. A round has at most 64 buyers.

### 2.3 Committing a bid **[contract]**

`commit_bid(round, commitment)` is called from the seller's own account, at or after `join_deadline` and before `commit_deadline`.

```
commitment = sha256( "quorum.bid.v1" ‖ round_id (u64 LE) ‖ seller_id (u64 LE) ‖ unit_price (u128 LE) ‖ salt (32 bytes) )
```

1. A buyer in the round cannot bid in it.
2. A seller commits at most once. A round has at most 32 bids.
3. Nobody, the contract included, can read the price from the commitment. Every bid is hidden until the commit window closes.

### 2.4 Revealing **[contract]**

`reveal_bid(round, unit_price, salt)` is called from the seller's own account, at or after `commit_deadline` and before `reveal_deadline`.

1. The contract recomputes the commitment and refuses a reveal that does not match it. A bid cannot change after the seller has seen how many others committed.
2. A bid that is never revealed does not count.

### 2.5 Closing **[contract]**

`close_round(round)` may be called by anyone, once `reveal_deadline` has passed, or as soon as `commit_deadline` has passed and every committed bid is revealed. The result follows from the bids alone.

1. **Valid bids** are revealed, have `0 < price ≤ reserve_price`, and come from sellers whose on-chain reputation is at least `min_reputation`. A seller with no score yet counts as 900.
2. **Winner**: the lowest valid price. Ties go to the earlier commitment.
3. **Clearing price**:
   - `FirstPrice`: the winner's own bid.
   - `SecondPrice`: the lowest losing valid bid, or the reserve price if the winner was the only valid bidder. Bidding your true cost is then the best strategy.
4. **Allocation**: every buyer whose limit is at or above the clearing price is allocated its full quantity, and its cost is `quantity × clearing_price`. A buyer whose limit is lower is left out and pays nothing.
5. **Void**: the round is void, with no winner, if there is no valid bid or no buyer accepts the clearing price.

### 2.6 What a round binds **[service]**

A job whose specification names a round (`spec.round`) is accepted only if:

1. the round is `Closed`;
2. the service matches the round's service;
3. the seller is the round's winner;
4. the buyer has an allocation in the round, and the IOU amount equals that allocation's cost exactly;
5. the buyer has not already bought its allocation (once per buyer per round).

The seller's quote for such a job reads the price from the chain; the seller does not choose it.

## 3. IOUs

Every paid job produces an IOU: the buyer's signed promise to pay the seller.

### 3.1 Messages

Every Quorum message is canonical JSON (keys sorted, integers as decimal strings) with a `type` field, signed under NEP-413. The recipient is the coordinator contract's account, and the nonce is `sha256(message)`. The IOU message is exactly:

```json
{"amount":"4000","buyer":"3","epoch":"12","jobHash":"0x…","nonce":"99","quoteHash":"0x…","seller":"7","token":"usdc.quorum.testnet","type":"IOU"}
```

The contract rebuilds this string from the IOU fields, its own token and its own account, so an IOU signed for another token or another deployment never verifies. **[contract]**

### 3.2 Acceptance **[service]**

The clearing service accepts an IOU only if all of these hold. Otherwise it refuses the IOU and records why, and the refusal is shown on the live floor.

1. It names the current epoch, while that epoch is taking IOUs.
2. Buyer and seller are different, registered and active.
3. The job specification hashes to `jobHash`, and the parties match.
4. The seller signed a quote for this job, at this price, that has not expired. `quoteHash` is that quote's digest.
5. The buyer signed the IOU, and the nonce is new for the buyer: higher than any nonce of the buyer in an earlier epoch.
6. It fits one of the buyer's intents (§6).
7. The buyer's free collateral covers all of its unsettled IOUs plus this one.

## 4. Epochs and netting

An epoch moves through these phases:

```
intake ──> challenge ──> closing ──> settling ──> sealed
```

| Phase | What happens |
|---|---|
| intake | New IOUs are accepted |
| challenge | No new IOUs; buyers can still dispute delivered jobs |
| closing | The epoch is netted on chain |
| settling | Debtors sign their transfers |
| sealed | The epoch has its receipt |

1. Default lengths are intake 75 s, challenge 18 s, a dispute window of 12 s after each delivery, and an arbitration timeout of 15 s. A local sandbox runs shorter. **[service]**
2. At the close, a job still being worked on gets a grace period (60 s by default) to deliver, and a job delivered in it keeps its full dispute window. A job still undelivered after that is voided: it is never paid and its budget returns to the intent. A dispute still open after the arbitration timeout holds its IOU out of the epoch (§5). **[service]**
3. The clearer posts the IOUs in strictly ascending (buyer, nonce) order, in chunks of up to 200. For every IOU the contract checks that **[contract]**:
   - it names this epoch;
   - it comes after the previous IOU in that order;
   - its nonce is above the buyer's last nonce in any earlier epoch;
   - it is not held out;
   - its amount is in range, buyer and seller differ, and the seller exists;
   - the buyer's registered key signed it (`env::ed25519_verify`).
4. `finalize_epoch` recomputes every agent's credit and debit from the posted IOUs. It then checks four things before it fixes the result **[contract]**:
   - **Positions sum to zero**: total credit = total debit = gross volume. This is asserted.
   - **The claims agree**: the clearer's claimed IOU-set hash and positions hash must equal the contract's own.
   - **Debts are covered**: each net debtor's debt is locked in its collateral, and the epoch does not finalise if any debtor's free collateral falls short.
   - **The plan is fixed**: the settlement plan is computed and stored.
5. **The settlement plan** is computed by the contract **[contract]**:
   - List debtors and creditors in the order they first appeared in the epoch.
   - Walk both lists. Each step pays `min(debtor's remaining debt, creditor's remaining claim)` from the current debtor to the current creditor.
   - Move to the next debtor or creditor when one reaches zero.

   This takes at most `debtors + creditors − 1` transfers, and there is no pool in between. The TypeScript mirror (`settlementPlan` in `Blockchain/core`) must produce the same plan; the plan hash is compared on every epoch.
6. An epoch with no debtors seals at once.

## 5. Disputes

1. A buyer may dispute a delivered job until its dispute window ends, with a signed `Dispute`. **[service]**
2. The highest-reputation staked validator who is not a party to the job is assigned. Alternatively, the buyer hires a validator for a verdict job; the buyer pays for verdicts. **[service]**
3. The request is recorded on chain (`validation_request`). The validator answers from its own account (`validation_response`) and must hold at least the minimum stake as collateral. **[contract]**
4. **Upheld**: the IOU is voided and never netted, the buyer's budget is restored, and the seller's reputation falls. **Rejected**: the IOU stands, and the buyer is marked for a frivolous dispute. An IOU held out of its epoch while undecided is carried into the next epoch if the dispute is rejected (`post_carried`), and released for good if upheld (`release_held_out`). **[service]**, **[contract]**

## 6. Spending limits (intents)

1. Every purchase must name an intent: a mandate signed by the buyer's operator, with a key the chain confirms is an access key of the operator's account. **[service]**
2. An intent sets a goal, a total budget, a per-job cap, a minimum seller reputation, an optional list of allowed services and sellers, and a validity window. **[service]**
3. An IOU that would break any limit is refused before it exists. The operator can revoke an intent at any time with a signed revocation. **[service]**

## 7. Settlement through NEAR Intents

1. Agents keep settlement money inside the verifier, deposited with `ft_transfer_call` to the verifier. **[verifier]**
2. After finalisation, each net debtor signs **one** NEP-413 payload addressed to the verifier. Its `transfer` intents must be exactly that debtor's lines of the plan: same order, same receivers, same token, same amounts. The payload's nonce is `sha256("quorum.settlement.v1:<contract>:<epoch>:<agent>")`, so the same debt can never be paid twice. **[service]**, **[verifier]**
3. Anyone holding the payloads may call `settle(epoch, payloads)`. The contract checks every payload against its plan line by line and forwards the batch to the verifier's `execute_intents`. The verifier executes the batch atomically: all of its transfers happen, or none do. **[contract]**
4. In the callback, the contract marks the debtors settled and unlocks their collateral, but only if the verifier executed the batch. If the verifier refused, nothing moved and the debts stay open. **[contract]**
5. When the last debtor is settled or defaulted, the epoch is sealed with a receipt hash over the IOU set, the positions, the plan and the settlements. **[contract]**

### Defaults **[contract]**

1. After the settlement deadline (between 5 seconds and 7 days, set at deployment), anyone may declare an unpaid debtor in default.
2. The debtor's locked collateral is seized and deposited into the verifier for exactly the creditors its plan lines name. Creditors are paid in full either way.
3. The clearing service does not declare defaults while its own connection to the chain has been unreliable, up to a two-hour cap. **[service]**

## 8. Reputation

```
quality      q = (completed + 2) / (completed + 2 + 6 × disputesLost)
reliability  r = (settledOnTime + 1) / (settledOnTime + 1 + 3 × defaults)
conduct      c = 1 − min(0.5, 0.1 × frivolousDisputes)
experience   e = min(1, log10(1 + completed) / 3)
score        = round(1000 × (0.55 q + 0.25 r + 0.10 c + 0.10 e))
```

1. Lost and frivolous disputes fade by half every 20 epochs. Defaults never fade. **[service]**
2. The clearer writes scores on chain once per epoch, in strictly increasing epoch order (`record_epoch_scores`). **[contract]**
3. The contract reads these scores when it applies a round's reputation floor. **[contract]**

## 9. Collateral

1. Collateral is deposited with `ft_transfer_call` to the coordinator, with `msg` set to the agent id. **[contract]**
2. Free collateral is `total − locked − pending withdrawal`. Net debts are locked at finalisation and unlocked at settlement. **[contract]**
3. Withdrawal takes two steps: request, then withdraw after the delay. The delay is longer than an epoch, and collateral locked in the meantime stays. **[contract]**

## 10. One round, step by step

A group buy of GPU hours with second-price pricing. Each arrow is a transaction or a signed message.

```
Buyer A           Buyers B, C          Sellers S1..S3         Coordinator (clearing.quorum.testnet)     Verifier
   |                   |                      |                              |                             |
   |-- open_round(GroupBuy, gpu-hour, spec_hash, qty 4, reserve 0.05) ----->|  round #7: Open             |
   |                   |-- join_round(#7, qty, max_price) ---------------->|  demand recorded            |
   |                   |                      |                              |  join_deadline passes       |
   |                   |                      |-- commit_bid(#7, sha256(...)) >|  3 hidden commitments      |
   |                   |                      |                              |  commit_deadline passes     |
   |                   |                      |-- reveal_bid(#7, price, salt) >|  each reveal checked        |
   |                   |                      |                              |  against its commitment     |
   |-- close_round(#7) (anyone may call) ---------------------------------->|  winner = lowest valid bid  |
   |                   |                      |                              |  price  = lowest losing bid |
   |                   |                      |                              |  allocations: qty × price   |
   |-- quote request ------------------------>| (price read from round #7)   |                             |
   |<-- signed quote --------------------------|                              |                             |
   |-- signed IOU (NEP-413), amount = A's allocation cost --> clearing service: checks round, intent, collateral
   |                   |-- the same, each for its own share ----------------> clearing service
   |                   |                      |-- signed delivery ----------> clearing service
   |                   |                      |                              |                             |
   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ epoch closes ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|                             |
   |                   |                      |      clearer: post_ious ---->|  every signature verified   |
   |                   |                      |      clearer: finalize ----->|  positions sum to 0, plan   |
   |-- signed transfer intents for A's plan lines --> clearing service        |                             |
   |                   |-- the same --------------------------------------> clearing service             |
   |                   |                      |      settle(epoch, payloads) >|  each payload == its lines  |
   |                   |                      |                              |-- execute_intents(batch) -->|
   |                   |                      |                              |<-- executed atomically -----|
   |                   |                      |                              |  debtors settled, sealed    |
```

## 11. Simulation mode

`pnpm sim` runs this market with scripted agents and **no model calls**:

1. A local NEAR sandbox starts, the contracts are deployed, and 20 buyer agents and 5 seller agents are created, each on its own sub-account.
2. **Buyers**: each round, a seeded generator picks the opener, the joiners, their quantities (1–8 hours) and their limits (55–100% of the $0.05 reserve).
3. **Sellers** each have a cost and one fixed strategy:

   | Seller | Cost / hour | Strategy |
   |---|---|---|
   | Atlas Compute | $0.024 | cost-plus: cost + 12% |
   | Borealis GPU | $0.021 | undercutter: 6% under the last clearing price, never below cost + 2% |
   | Cinder Cloud | $0.019 | adaptive: 3% under the mean of the last five clearing prices, never below cost + 8% |
   | Drift Render | $0.030 | opportunist: just under the reserve |
   | Ember Nodes | $0.022 | noisy: cost + a seeded random 5–45% |

4. The same seed gives the same demand and the same bids. `pnpm sim --seed 7 --rounds 12` changes both.
5. At the end, `pnpm sim` re-checks every round and epoch against the chain (shares add up, limits respected, the cheapest valid bid won, every allocation was bought, every epoch settled and verified), prints a report and exits 0 only if every check passed.

The GPU hours are simulated: a seller's delivery is a signed lease receipt that says so. The market around it is real: the rounds, IOUs, netting and settlement all happen on chain.

## 12. Studios

A studio is an agent that sells a finished product and hires its own team to make it. **[service]** unless marked.

1. A client hires a studio's lead like any other seller: a signed quote at the studio's posted price, an IOU under the client's intent, a signed delivery.
2. For each role on its team, the lead opens a tender from its own account with the role's reserve price, all at once. Freelancers bid sealed and reveal; the contract picks each winner at the second price. **[contract]**
3. The lead buys each role from that round's winner at the round's price (§2.6). A role whose round is void, or whose work was disputed and voided, is bought at a posted price from the cheapest other seller above reputation 500.
4. The lead pays its team from its own standing intent, signed by its operator, capped at 0.01 tUSDC per job.
5. Before it delivers, the lead checks the work: palette contrast against WCAG AA, the contract audit (no high-severity finding), the API cross-check (every operation handled, every field a column), image sizes, and caption timing. A contract that fails the audit is disputed (§5); the validator re-runs the audit on the delivered source and rules.
6. A freelancer never audits a contract it wrote: the auditors and the coders are different agents.
7. Files a studio delivers are stored under their sha256 and served at `/media/<sha256>.<ext>`. The delivery's result carries the hash, and the seller's signature covers the result.
8. The client's debt to the lead and the lead's debts to its team are ordinary IOUs: they net in the epoch they were signed in and settle in the same batch (§4, §7).

## 13. Accounts

1. Signing in is a NEP-413 message naming the account, the network and the time, signed for `quorum-sign-in`. The clearing service accepts it only if the signature verifies, the key is a full-access key of the account on chain, the message is under ten minutes old and its nonce was never used. **[service]**
2. A session lasts seven days and is a MAC over the account and the expiry; the backend alone holds the key.
3. A user agent is a sub-account of the deployment's root, registered from its own account with the user's account as its operator. **[contract]**
4. Only an agent's operator can authorise its spending: an intent must be signed by a full-access key of the operator account (§6). **[service]**
5. An account may run up to three user agents; the swarm funds each with 2 tUSDC of collateral and 2 tUSDC inside the verifier.
6. The dev wallet exists on the local sandbox only.
