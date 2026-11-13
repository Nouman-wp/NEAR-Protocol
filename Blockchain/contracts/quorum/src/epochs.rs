//! Epochs: verify every signed IOU, net the positions, and settle the differences
//! through NEAR Intents.
use crate::util::*;
use crate::*;
use near_sdk::json_types::U64;
use std::collections::HashMap;

/// 1,000,000 units of a 6-decimal stablecoin.
pub const MAX_IOU_AMOUNT: u128 = 1_000_000_000_000;
pub const MAX_POST_CHUNK: usize = 200;
/// How long a sealed epoch or a closed round stays in state before it may be pruned.
pub const PRUNE_AGE_MS: u64 = 10 * 60_000;
const GAS_SETTLE_CALLBACK: Gas = Gas::from_tgas(25);
const GAS_SETTLE_RESERVE: Gas = Gas::from_tgas(30);
const GAS_DEFAULT_PAYOUT: Gas = Gas::from_tgas(45);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum EpochStatus {
    Open,
    Posting,
    Finalized,
    Sealed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PositionState {
    Flat,
    /// Net debtor that has not paid yet.
    Owes,
    /// Its signed transfer is at the verifier; the callback decides.
    Submitted,
    Settled,
    Defaulted,
    Creditor,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct Transfer {
    pub from: AgentId,
    pub to: AgentId,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Epoch {
    pub id: u64,
    pub status: EpochStatus,
    pub iou_count: u32,
    pub carried_count: u32,
    pub held_out_count: u32,
    pub gross_volume: U128,
    pub net_volume: U128,
    pub debtor_count: u32,
    pub creditor_count: u32,
    pub open_debtors: u32,
    pub default_count: u32,
    /// (buyer << 64) | nonce of the last IOU posted: posting order is strictly ascending.
    pub last_key: U128,
    pub iou_set_hash: String,
    pub positions_hash: String,
    pub plan_hash: String,
    pub settlements_hash: String,
    pub receipt_hash: String,
    /// Agents in the order they first appeared in a posted IOU.
    pub participants: Vec<AgentId>,
    /// The transfers that settle the epoch: one or more per net debtor, straight to creditors.
    pub plan: Vec<Transfer>,
    pub finalized_at: u64,
    pub settle_deadline: u64,
    pub sealed_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Position {
    pub credit: U128,
    pub debit: U128,
    pub state: PositionState,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub agent: AgentId,
    pub credit: U128,
    pub debit: U128,
    /// credit - debit as a signed decimal string.
    pub net: String,
    pub state: PositionState,
}

/// One signed IOU as the clearer posts it. The token and the verifying contract are
/// not arguments: the contract fills in its own, so an IOU signed for another token or
/// another deployment never verifies here.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct IouInput {
    pub buyer: AgentId,
    pub seller: AgentId,
    pub amount: U128,
    pub job_hash: String,
    pub quote_hash: String,
    pub epoch: u64,
    pub nonce: U64,
    /// "ed25519:<base58>" over the NEP-413 hash of the canonical IOU message.
    pub signature: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Nep413Payload {
    pub message: String,
    pub nonce: String,
    pub recipient: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "callbackUrl")]
    pub callback_url: Option<String>,
}

/// A signed NEAR Intents payload, exactly as the verifier's `execute_intents` takes it.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct SignedIntent {
    pub standard: String,
    pub payload: Nep413Payload,
    pub public_key: String,
    pub signature: String,
}

/// In-memory tally of one posting call, written to storage once at the end.
struct Book {
    order: Vec<AgentId>,
    index: HashMap<AgentId, usize>,
    credit: Vec<u128>,
    debit: Vec<u128>,
}

impl Book {
    fn new() -> Self {
        Self { order: Vec::new(), index: HashMap::new(), credit: Vec::new(), debit: Vec::new() }
    }

    fn slot(&mut self, id: AgentId) -> usize {
        if let Some(i) = self.index.get(&id) {
            return *i;
        }
        let i = self.order.len();
        self.order.push(id);
        self.credit.push(0);
        self.debit.push(0);
        self.index.insert(id, i);
        i
    }
}

#[near]
impl Quorum {
    // ------------------------------------------------------------------ posting

    /// Keep disputed IOUs out of this epoch's netting until their dispute is decided.
    pub fn hold_out(&mut self, epoch: u64, digests: Vec<String>) {
        self.only_clearer();
        let mut e = self.open_epoch(epoch);
        require!(e.status == EpochStatus::Open, "hold-outs must be posted before any IOU");
        for d in &digests {
            self.held_out.insert(unhex32(d), epoch);
        }
        e.held_out_count += digests.len() as u32;
        emit("ious_held_out", serde_json::json!({ "epoch": epoch, "digests": digests }));
        self.epochs.insert(epoch, e);
    }

    /// The dispute was upheld: the IOU is void and will never be posted.
    pub fn release_held_out(&mut self, digest: String) {
        self.only_clearer();
        let origin = self.held_out.remove(&unhex32(&digest)).unwrap_or_else(|| env::panic_str("IOU is not held out"));
        emit("held_out_released", serde_json::json!({ "origin_epoch": origin, "digest": digest }));
    }

    /// The dispute was rejected: the IOU counts after all, in the current epoch.
    pub fn post_carried(&mut self, epoch: u64, iou: IouInput) {
        self.only_clearer();
        let mut e = self.open_epoch(epoch);
        let token = self.token.to_string();
        let me = env::current_account_id().to_string();
        let digest = iou_digest_of(&iou, &token, &me);
        let origin = self.held_out.get(&digest).copied().unwrap_or(0);
        require!(origin != 0 && origin == iou.epoch && origin < epoch, "IOU is not held out from an earlier epoch");
        self.held_out.remove(&digest);
        self.check_iou(&iou, None);
        let buyer_key = ed25519_bytes(&self.agent(iou.buyer).public_key);
        require!(env::ed25519_verify(&decode_signature(&iou.signature), &digest, &buyer_key), "bad IOU signature");

        let mut book = Book::new();
        let b = book.slot(iou.buyer);
        book.debit[b] += iou.amount.0;
        let s = book.slot(iou.seller);
        book.credit[s] += iou.amount.0;
        let set_hash = hash_parts(&[&unhex32(&e.iou_set_hash), &digest]);
        e.iou_set_hash = hex32(&set_hash);
        e.iou_count += 1;
        e.carried_count += 1;
        e.gross_volume.0 += iou.amount.0;
        e.status = EpochStatus::Posting;
        self.flush(&mut e, book);
        emit("iou_carried", serde_json::json!({ "epoch": epoch, "origin_epoch": origin, "digest": hex32(&digest) }));
        self.epochs.insert(epoch, e);
    }

    /// Post a chunk of this epoch's IOUs in strictly ascending (buyer, nonce) order.
    /// Every signature is checked against the buyer's registered key. Nothing is stored
    /// per IOU: the order rule and `last_nonce` are what stop an IOU counting twice.
    pub fn post_ious(&mut self, epoch: u64, ious: Vec<IouInput>) {
        self.only_clearer();
        require!(!ious.is_empty() && ious.len() <= MAX_POST_CHUNK, "chunk size out of range");
        let mut e = self.open_epoch(epoch);
        let token = self.token.to_string();
        let me = env::current_account_id().to_string();

        let mut last_key = e.last_key.0;
        let mut set_hash = unhex32(&e.iou_set_hash);
        let mut gross = 0u128;
        let mut book = Book::new();
        // The chunk is sorted by buyer, so the buyer's key and nonce are loaded once per run.
        let mut current: Option<(AgentId, [u8; 32], u64)> = None;

        for iou in &ious {
            require!(iou.epoch == epoch, "IOU belongs to a different epoch");
            let key = ((iou.buyer as u128) << 64) | iou.nonce.0 as u128;
            require!(key > last_key, "IOUs are out of order or repeated");
            last_key = key;

            let (buyer_key, prev_nonce) = match current {
                Some((id, k, n)) if id == iou.buyer => (k, n),
                _ => {
                    if let Some((id, _, n)) = current {
                        self.last_nonce.insert(id, n);
                    }
                    let k = ed25519_bytes(&self.agent(iou.buyer).public_key);
                    (k, self.last_nonce.get(&iou.buyer).copied().unwrap_or(0))
                }
            };
            require!(iou.nonce.0 > prev_nonce, "IOU nonce was already used in an earlier epoch");
            current = Some((iou.buyer, buyer_key, iou.nonce.0));

            let digest = iou_digest_of(iou, &token, &me);
            require!(self.held_out.get(&digest).is_none(), "IOU is held out by an open dispute");
            self.check_iou(iou, Some(&book));
            require!(env::ed25519_verify(&decode_signature(&iou.signature), &digest, &buyer_key), "bad IOU signature");

            let b = book.slot(iou.buyer);
            book.debit[b] += iou.amount.0;
            let s = book.slot(iou.seller);
            book.credit[s] += iou.amount.0;
            gross += iou.amount.0;
            set_hash = hash_parts(&[&set_hash, &digest]);
        }
        if let Some((id, _, n)) = current {
            self.last_nonce.insert(id, n);
        }

        e.last_key = U128(last_key);
        e.iou_set_hash = hex32(&set_hash);
        e.iou_count += ious.len() as u32;
        e.gross_volume.0 += gross;
        e.status = EpochStatus::Posting;
        self.flush(&mut e, book);
        emit(
            "ious_posted",
            serde_json::json!({ "epoch": epoch, "count": ious.len(), "iou_count": e.iou_count, "gross_volume": e.gross_volume, "iou_set_hash": e.iou_set_hash }),
        );
        self.epochs.insert(epoch, e);
    }

    // ------------------------------------------------------------------ netting

    /// Net the epoch. The clearer states the result it expects and the contract refuses
    /// to finalise unless its own computation agrees. Every net debt is locked in the
    /// debtor's collateral, and the settlement plan is fixed here.
    pub fn finalize_epoch(&mut self, epoch: u64, expected_iou_set_hash: String, expected_positions_hash: String) {
        self.only_clearer();
        let mut e = self.open_epoch(epoch);
        require!(e.iou_set_hash == expected_iou_set_hash, "IOU set does not match the claimed hash");

        let mut positions_hash = unhex32(ZERO_HEX);
        let mut total_credit = 0u128;
        let mut total_debit = 0u128;
        let mut net_volume = 0u128;
        let mut debtors: Vec<(AgentId, u128)> = Vec::new();
        let mut creditors: Vec<(AgentId, u128)> = Vec::new();

        for id in e.participants.clone() {
            let mut p = self.positions.get(&(epoch, id)).cloned().unwrap_or_else(|| env::panic_str("missing position"));
            let (credit, debit) = (p.credit.0, p.debit.0);
            total_credit += credit;
            total_debit += debit;
            positions_hash = hash_parts(&[&positions_hash, &id.to_le_bytes(), &credit.to_le_bytes(), &debit.to_le_bytes()]);
            if debit > credit {
                let owed = debit - credit;
                let mut c = self.collateral_of(id);
                if available(&c) < owed {
                    env::panic_str(&format!("agent {id} owes {owed} but has only {} free collateral", available(&c)));
                }
                c.locked.0 += owed;
                self.collateral.insert(id, c);
                p.state = PositionState::Owes;
                debtors.push((id, owed));
            } else if credit > debit {
                net_volume += credit - debit;
                p.state = PositionState::Creditor;
                creditors.push((id, credit - debit));
            }
            self.positions.insert((epoch, id), p);
        }
        // Net positions sum to zero by construction. Assert it anyway.
        assert!(total_credit == total_debit && total_credit == e.gross_volume.0, "netting invariant broken");
        let positions_hex = hex32(&positions_hash);
        require!(positions_hex == expected_positions_hash, "positions do not match the claimed hash");

        let plan = settlement_plan(&debtors, &creditors);
        let mut plan_hash = unhex32(ZERO_HEX);
        for t in &plan {
            plan_hash = hash_parts(&[&plan_hash, &t.from.to_le_bytes(), &t.to.to_le_bytes(), &t.amount.0.to_le_bytes()]);
        }

        let now = env::block_timestamp_ms();
        e.positions_hash = positions_hex;
        e.plan_hash = hex32(&plan_hash);
        e.plan = plan;
        e.net_volume = U128(net_volume);
        e.debtor_count = debtors.len() as u32;
        e.creditor_count = creditors.len() as u32;
        e.open_debtors = debtors.len() as u32;
        e.finalized_at = now;
        e.settle_deadline = now + self.settlement_window_ms;
        e.status = EpochStatus::Finalized;
        self.current_epoch = epoch + 1;
        emit(
            "epoch_finalized",
            serde_json::json!({
                "epoch": epoch, "iou_set_hash": e.iou_set_hash, "positions_hash": e.positions_hash, "plan_hash": e.plan_hash,
                "iou_count": e.iou_count, "gross_volume": e.gross_volume, "net_volume": e.net_volume,
                "debtors": e.debtor_count, "creditors": e.creditor_count, "transfers": e.plan.len(), "settle_deadline": e.settle_deadline
            }),
        );
        if e.debtor_count == 0 {
            seal(&mut e); // nothing to settle
        }
        self.epochs.insert(epoch, e);
    }

    // ------------------------------------------------------------------ settlement

    /// Settle net debts through NEAR Intents. Each element is one debtor's signed payload.
    /// The contract accepts it only if its `transfer` intents are exactly that debtor's
    /// lines in the plan, then forwards the batch to the verifier. The verifier executes
    /// the batch atomically, and the callback marks the debtors settled only if it did.
    /// Anyone holding the signed payloads may call this.
    pub fn settle(&mut self, epoch: u64, signed: Vec<SignedIntent>) -> Promise {
        require!(!signed.is_empty(), "nothing to settle");
        let e = self.epochs.get(&epoch).cloned().unwrap_or_else(|| env::panic_str("unknown epoch"));
        require!(e.status == EpochStatus::Finalized, "epoch is not awaiting settlement");
        let token_id = format!("nep141:{}", self.token);
        let mut agents: Vec<AgentId> = Vec::with_capacity(signed.len());

        for s in &signed {
            require!(s.standard == "nep413", "settlement intents must be NEP-413 signed");
            require!(s.payload.recipient == self.intents.as_str(), "intent is addressed to a different verifier");
            let msg: serde_json::Value =
                serde_json::from_str(&s.payload.message).unwrap_or_else(|_| env::panic_str("intent message is not JSON"));
            let signer: AccountId = msg
                .get("signer_id")
                .and_then(|v| v.as_str())
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| env::panic_str("intent message needs signer_id"));
            let agent_id = *self.agent_by_account.get(&signer).unwrap_or_else(|| env::panic_str("signer is not a registered agent"));
            require!(!agents.contains(&agent_id), "one payload per debtor");

            let mut p = self.positions.get(&(epoch, agent_id)).cloned().unwrap_or_else(|| env::panic_str("signer has no position"));
            require!(p.state == PositionState::Owes, "signer has no open debt in this epoch");

            let expected: Vec<(AccountId, u128)> =
                e.plan.iter().filter(|t| t.from == agent_id).map(|t| (self.agent(t.to).account, t.amount.0)).collect();
            let intents = msg.get("intents").and_then(|v| v.as_array()).unwrap_or_else(|| env::panic_str("intent message needs intents"));
            require!(intents.len() == expected.len(), "intents do not match the settlement plan");
            for (intent, (receiver, amount)) in intents.iter().zip(expected.iter()) {
                require!(intent.get("intent").and_then(|v| v.as_str()) == Some("transfer"), "only transfer intents settle a debt");
                require!(
                    intent.get("receiver_id").and_then(|v| v.as_str()) == Some(receiver.as_str()),
                    "transfer receiver does not match the plan"
                );
                let tokens = intent.get("tokens").and_then(|v| v.as_object()).unwrap_or_else(|| env::panic_str("transfer needs tokens"));
                require!(tokens.len() == 1, "a settlement transfer moves one token");
                let got: u128 = tokens
                    .get(&token_id)
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| env::panic_str("transfer is not in the settlement token"));
                require!(got == *amount, "transfer amount does not match the plan");
            }

            p.state = PositionState::Submitted;
            self.positions.insert((epoch, agent_id), p);
            agents.push(agent_id);
        }

        let args = serde_json::json!({ "signed": signed }).to_string().into_bytes();
        let forward = env::prepaid_gas()
            .saturating_sub(env::used_gas())
            .saturating_sub(GAS_SETTLE_CALLBACK)
            .saturating_sub(GAS_SETTLE_RESERVE);
        Promise::new(self.intents.clone())
            .function_call("execute_intents".to_string(), args, NearToken::from_yoctonear(0), forward)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_settled(epoch, agents))
    }

    #[private]
    pub fn on_settled(&mut self, epoch: u64, agents: Vec<AgentId>) -> bool {
        let ok = near_sdk::is_promise_success();
        let mut e = self.epochs.get(&epoch).cloned().unwrap_or_else(|| env::panic_str("unknown epoch"));
        let mut settlements_hash = unhex32(&e.settlements_hash);
        for id in &agents {
            let mut p = self.positions.get(&(epoch, *id)).cloned().unwrap_or_else(|| env::panic_str("missing position"));
            if p.state != PositionState::Submitted {
                continue;
            }
            if ok {
                let owed = p.debit.0 - p.credit.0;
                let mut c = self.collateral_of(*id);
                c.locked.0 = c.locked.0.saturating_sub(owed);
                self.collateral.insert(*id, c);
                p.state = PositionState::Settled;
                e.open_debtors -= 1;
                settlements_hash = hash_parts(&[&settlements_hash, &id.to_le_bytes(), &owed.to_le_bytes(), b"INTENTS"]);
            } else {
                p.state = PositionState::Owes; // the verifier refused the batch: nothing moved
            }
            self.positions.insert((epoch, *id), p);
        }
        e.settlements_hash = hex32(&settlements_hash);
        emit("debtors_settled", serde_json::json!({ "epoch": epoch, "agents": agents, "executed": ok }));
        if ok && e.open_debtors == 0 {
            seal(&mut e);
        }
        self.epochs.insert(epoch, e);
        ok
    }

    /// After the deadline anyone may declare an unpaid debtor in default. Its locked
    /// collateral is seized and deposited into the verifier for the creditors the plan
    /// says it owes, so they are paid in full either way.
    pub fn declare_default(&mut self, epoch: u64, agent_id: AgentId) {
        let mut e = self.epochs.get(&epoch).cloned().unwrap_or_else(|| env::panic_str("unknown epoch"));
        require!(e.status == EpochStatus::Finalized, "epoch is not awaiting settlement");
        require!(env::block_timestamp_ms() > e.settle_deadline, "the settlement deadline has not passed");
        let mut p = self.positions.get(&(epoch, agent_id)).cloned().unwrap_or_else(|| env::panic_str("agent has no position"));
        require!(p.state == PositionState::Owes, "agent has no open debt in this epoch");
        let owed = p.debit.0 - p.credit.0;

        let mut c = self.collateral_of(agent_id);
        c.locked.0 -= owed;
        c.total.0 -= owed;
        self.collateral.insert(agent_id, c);

        for t in e.plan.iter().filter(|t| t.from == agent_id) {
            let creditor = self.agent(t.to).account;
            let args = serde_json::json!({ "receiver_id": self.intents, "amount": t.amount, "msg": creditor.to_string(), "memo": format!("quorum default cover, epoch {epoch}") })
                .to_string()
                .into_bytes();
            Promise::new(self.token.clone())
                .function_call("ft_transfer_call".to_string(), args, NearToken::from_yoctonear(1), GAS_DEFAULT_PAYOUT)
                .detach();
        }

        p.state = PositionState::Defaulted;
        self.positions.insert((epoch, agent_id), p);
        e.open_debtors -= 1;
        e.default_count += 1;
        e.settlements_hash = hex32(&hash_parts(&[&unhex32(&e.settlements_hash), &agent_id.to_le_bytes(), &owed.to_le_bytes(), b"DEFAULT"]));
        emit("debtor_defaulted", serde_json::json!({ "epoch": epoch, "agent": agent_id, "amount": U128(owed) }));
        if e.open_debtors == 0 {
            seal(&mut e);
        }
        self.epochs.insert(epoch, e);
    }

    // ------------------------------------------------------------------ storage

    /// Delete sealed epochs and closed rounds from contract state to give their storage back.
    /// Only the clearer or the owner may call it, and only for items that finished at least
    /// PRUNE_AGE_MS ago. Items that do not qualify are skipped, not refused. The clearing
    /// service keeps the full history and the events stay in the chain's history.
    pub fn prune(&mut self, epochs: Vec<u64>, rounds: Vec<u64>) -> (u32, u32) {
        let caller = env::predecessor_account_id();
        require!(caller == self.clearer || caller == self.owner, "only the clearer or the owner may prune");
        require!(epochs.len() + rounds.len() <= 40, "prune at most 40 items per call");
        let now = env::block_timestamp_ms();
        let mut pruned_epochs = Vec::new();
        for id in epochs {
            let Some(e) = self.epochs.get(&id).cloned() else { continue };
            if e.status != EpochStatus::Sealed || id >= self.current_epoch || e.sealed_at + PRUNE_AGE_MS > now {
                continue;
            }
            for agent in &e.participants {
                self.positions.remove(&(id, *agent));
            }
            self.epochs.remove(&id);
            pruned_epochs.push(id);
        }
        let mut pruned_rounds = Vec::new();
        for id in rounds {
            let Some(r) = self.rounds.get(&id) else { continue };
            if r.status == RoundStatus::Open || r.closed_at + PRUNE_AGE_MS > now {
                continue;
            }
            self.rounds.remove(&id);
            pruned_rounds.push(id);
        }
        if !pruned_epochs.is_empty() || !pruned_rounds.is_empty() {
            emit("pruned", serde_json::json!({ "epochs": pruned_epochs, "rounds": pruned_rounds }));
        }
        (pruned_epochs.len() as u32, pruned_rounds.len() as u32)
    }

    // ------------------------------------------------------------------ views

    /// The digest the buyer signs for an IOU, as lower-case hex.
    pub fn iou_digest(&self, iou: IouInput) -> String {
        hex32(&iou_digest_of(&iou, self.token.as_str(), env::current_account_id().as_str()))
    }

    pub fn get_epoch(&self, epoch: u64) -> Option<Epoch> {
        self.epochs.get(&epoch).cloned()
    }

    pub fn get_position(&self, epoch: u64, agent_id: AgentId) -> Option<PositionView> {
        self.positions.get(&(epoch, agent_id)).map(|p| position_view(agent_id, p))
    }

    pub fn get_positions(&self, epoch: u64) -> Vec<PositionView> {
        let Some(e) = self.epochs.get(&epoch) else { return vec![] };
        e.participants.iter().filter_map(|id| self.positions.get(&(epoch, *id)).map(|p| position_view(*id, p))).collect()
    }

    pub fn last_nonce_of(&self, agent_id: AgentId) -> U64 {
        U64(self.last_nonce.get(&agent_id).copied().unwrap_or(0))
    }

    pub fn held_out_epoch(&self, digest: String) -> u64 {
        self.held_out.get(&unhex32(&digest)).copied().unwrap_or(0)
    }
}

impl Quorum {
    /// The current epoch, if it is still taking IOUs.
    fn open_epoch(&self, epoch: u64) -> Epoch {
        require!(epoch == self.current_epoch, "not the current epoch");
        let e = self.epochs.get(&epoch).cloned().unwrap_or_else(|| new_epoch(epoch));
        require!(matches!(e.status, EpochStatus::Open | EpochStatus::Posting), "epoch is already finalized");
        e
    }

    fn check_iou(&self, iou: &IouInput, seen: Option<&Book>) {
        require!(iou.amount.0 > 0 && iou.amount.0 <= MAX_IOU_AMOUNT, "IOU amount out of range");
        require!(iou.buyer != iou.seller, "an agent cannot owe itself");
        // A seller already in this call's book was checked before.
        if !seen.is_some_and(|b| b.index.contains_key(&iou.seller)) {
            require!(self.agents.get(&iou.seller).is_some(), "unknown seller");
        }
    }

    /// Add one call's tally to the stored positions, registering new participants in
    /// first-appearance order.
    fn flush(&mut self, e: &mut Epoch, book: Book) {
        for (i, id) in book.order.iter().enumerate() {
            let mut p = match self.positions.get(&(e.id, *id)) {
                Some(p) => p.clone(),
                None => {
                    e.participants.push(*id);
                    Position { credit: U128(0), debit: U128(0), state: PositionState::Flat }
                }
            };
            p.credit.0 += book.credit[i];
            p.debit.0 += book.debit[i];
            self.positions.insert((e.id, *id), p);
        }
    }
}

fn new_epoch(id: u64) -> Epoch {
    Epoch {
        id,
        status: EpochStatus::Open,
        iou_count: 0,
        carried_count: 0,
        held_out_count: 0,
        gross_volume: U128(0),
        net_volume: U128(0),
        debtor_count: 0,
        creditor_count: 0,
        open_debtors: 0,
        default_count: 0,
        last_key: U128(0),
        iou_set_hash: ZERO_HEX.to_string(),
        positions_hash: ZERO_HEX.to_string(),
        plan_hash: ZERO_HEX.to_string(),
        settlements_hash: ZERO_HEX.to_string(),
        receipt_hash: ZERO_HEX.to_string(),
        participants: Vec::new(),
        plan: Vec::new(),
        finalized_at: 0,
        settle_deadline: 0,
        sealed_at: 0,
    }
}

fn seal(e: &mut Epoch) {
    e.status = EpochStatus::Sealed;
    e.sealed_at = env::block_timestamp_ms();
    let receipt = hash_parts(&[
        env::current_account_id().as_bytes(),
        &e.id.to_le_bytes(),
        &unhex32(&e.iou_set_hash),
        &unhex32(&e.positions_hash),
        &unhex32(&e.plan_hash),
        &unhex32(&e.settlements_hash),
    ]);
    e.receipt_hash = hex32(&receipt);
    emit("epoch_sealed", serde_json::json!({ "epoch": e.id, "receipt_hash": e.receipt_hash, "defaults": e.default_count }));
}

fn position_view(agent: AgentId, p: &Position) -> PositionView {
    let net = if p.credit.0 >= p.debit.0 { (p.credit.0 - p.debit.0).to_string() } else { format!("-{}", p.debit.0 - p.credit.0) };
    PositionView { agent, credit: p.credit, debit: p.debit, net, state: p.state }
}

/// The canonical IOU message: JSON with sorted keys and every number as a decimal string,
/// exactly what `canonicalJson` in Blockchain/core produces.
pub fn iou_message(iou: &IouInput, token: &str) -> String {
    // The two hashes are checked to be plain lower-case hex, so they cannot smuggle JSON.
    unhex32(&iou.job_hash);
    unhex32(&iou.quote_hash);
    format!(
        r#"{{"amount":"{}","buyer":"{}","epoch":"{}","jobHash":"{}","nonce":"{}","quoteHash":"{}","seller":"{}","token":"{}","type":"IOU"}}"#,
        iou.amount.0, iou.buyer, iou.epoch, iou.job_hash, iou.nonce.0, iou.quote_hash, iou.seller, token
    )
}

pub fn iou_digest_of(iou: &IouInput, token: &str, contract: &str) -> Hash {
    nep413_hash(&iou_message(iou, token), contract)
}

/// Pay every creditor from the debtors in order: at most debtors + creditors - 1 transfers.
pub fn settlement_plan(debtors: &[(AgentId, u128)], creditors: &[(AgentId, u128)]) -> Vec<Transfer> {
    let mut plan = Vec::new();
    let (mut d, mut c) = (0usize, 0usize);
    let mut owed = debtors.first().map(|x| x.1).unwrap_or(0);
    let mut due = creditors.first().map(|x| x.1).unwrap_or(0);
    while d < debtors.len() && c < creditors.len() {
        let amount = owed.min(due);
        plan.push(Transfer { from: debtors[d].0, to: creditors[c].0, amount: U128(amount) });
        owed -= amount;
        due -= amount;
        if owed == 0 {
            d += 1;
            owed = debtors.get(d).map(|x| x.1).unwrap_or(0);
        }
        if due == 0 {
            c += 1;
            due = creditors.get(c).map(|x| x.1).unwrap_or(0);
        }
    }
    plan
}
