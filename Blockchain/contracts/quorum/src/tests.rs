use crate::util::*;
use crate::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U64;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

const CONTRACT: &str = "clearing.quorum.test.near";
const OWNER: &str = "quorum.test.near";
const CLEARER: &str = "clearer.quorum.test.near";
const TOKEN: &str = "usdc.quorum.test.near";
const INTENTS: &str = "intents.quorum.test.near";
const H1: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const H2: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const T0: u64 = 1_800_000_000_000;

struct World {
    q: Quorum,
    keys: HashMap<AgentId, SigningKey>,
    now: u64,
}

fn account(name: &str) -> String {
    format!("{name}.quorum.test.near")
}

impl World {
    fn new() -> Self {
        let mut w = World { q: Quorum::new_for_test(), keys: HashMap::new(), now: T0 };
        w.as_account(OWNER);
        w
    }

    fn as_account(&mut self, who: &str) {
        self.as_with(who, vec![]);
    }

    fn as_with(&mut self, who: &str, results: Vec<PromiseResult>) {
        let ctx = VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(who.parse().unwrap())
            .signer_account_id(who.parse().unwrap())
            .block_timestamp(self.now * 1_000_000)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        testing_env!(ctx, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), HashMap::default(), results);
    }

    fn advance(&mut self, ms: u64) {
        self.now += ms;
    }

    /// Register `name` as an agent with a fresh key and `collateral` units of stake.
    fn agent(&mut self, name: &str, collateral: u128) -> AgentId {
        let seed = (self.keys.len() + 1) as u8;
        let key = SigningKey::from_bytes(&[seed; 32]);
        let pk: PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
        self.as_account(&account(name));
        let id = self.q.register(format!("https://agents.example/{name}"), Some(pk), None);
        self.keys.insert(id, key);
        if collateral > 0 {
            self.as_account(TOKEN);
            self.q.ft_on_transfer(account(name).parse().unwrap(), U128(collateral), String::new());
        }
        id
    }

    fn iou(&self, epoch: u64, buyer: AgentId, seller: AgentId, amount: u128, nonce: u64) -> IouInput {
        let mut iou = IouInput {
            buyer,
            seller,
            amount: U128(amount),
            job_hash: H1.into(),
            quote_hash: H2.into(),
            epoch,
            nonce: U64(nonce),
            signature: String::new(),
        };
        let digest = iou_digest_of(&iou, TOKEN, CONTRACT);
        iou.signature = format!("ed25519:{}", bs58::encode(self.keys[&buyer].sign(&digest).to_bytes()).into_string());
        iou
    }

    fn post(&mut self, epoch: u64, ious: Vec<IouInput>) {
        self.as_account(CLEARER);
        self.q.post_ious(epoch, ious);
    }

    /// Finalise with whatever hashes the contract itself computed.
    fn finalize(&mut self, epoch: u64) {
        self.as_account(CLEARER);
        let e = self.q.get_epoch(epoch).unwrap();
        let mut positions_hash = unhex32(ZERO_HEX);
        for id in &e.participants {
            let p = self.q.get_position(epoch, *id).unwrap();
            positions_hash = hash_parts(&[&positions_hash, &id.to_le_bytes(), &p.credit.0.to_le_bytes(), &p.debit.0.to_le_bytes()]);
        }
        self.q.finalize_epoch(epoch, e.iou_set_hash, hex32(&positions_hash));
    }

    fn intent(&self, signer: &str, transfers: &[(&str, u128)]) -> SignedIntent {
        let intents: Vec<serde_json::Value> = transfers
            .iter()
            .map(|(to, amount)| {
                serde_json::json!({ "intent": "transfer", "receiver_id": account(to), "tokens": { format!("nep141:{TOKEN}"): amount.to_string() } })
            })
            .collect();
        SignedIntent {
            standard: "nep413".into(),
            payload: Nep413Payload {
                message: serde_json::json!({ "signer_id": account(signer), "deadline": "2030-01-01T00:00:00.000Z", "intents": intents }).to_string(),
                nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into(),
                recipient: INTENTS.into(),
                callback_url: None,
            },
            public_key: "ed25519:11111111111111111111111111111111".into(),
            signature: "ed25519:1".into(),
        }
    }
}

impl Quorum {
    fn new_for_test() -> Self {
        testing_env!(VMContextBuilder::new().current_account_id(CONTRACT.parse().unwrap()).build());
        Quorum::new(
            OWNER.parse().unwrap(),
            CLEARER.parse().unwrap(),
            TOKEN.parse().unwrap(),
            INTENTS.parse().unwrap(),
            60_000,
            120_000,
            U128(1_000_000),
        )
    }
}

fn net(w: &World, epoch: u64, id: AgentId) -> String {
    w.q.get_position(epoch, id).unwrap().net
}

// ---------------------------------------------------------------------- registry

#[test]
fn registers_agents_with_sequential_ids() {
    let mut w = World::new();
    let a = w.agent("scout", 0);
    let b = w.agent("scribe", 0);
    assert_eq!((a, b), (1, 2));
    let scout = w.q.get_agent(1).unwrap();
    assert_eq!(scout.account.as_str(), "scout.quorum.test.near");
    assert_eq!(scout.operator, scout.account);
    assert_eq!(w.q.agent_id_of("scribe.quorum.test.near".parse().unwrap()), Some(2));
    assert_eq!(w.q.reputation_of(1), DEFAULT_REPUTATION);
}

#[test]
#[should_panic(expected = "account is already registered")]
fn an_account_registers_once() {
    let mut w = World::new();
    w.agent("scout", 0);
    w.as_account(&account("scout"));
    w.q.register("x".into(), None, None);
}

#[test]
#[should_panic(expected = "only the agent or its operator")]
fn strangers_cannot_pause_an_agent() {
    let mut w = World::new();
    let a = w.agent("scout", 0);
    w.agent("rogue", 0);
    w.as_account(&account("rogue"));
    w.q.set_status(a, AgentStatus::Paused);
}

// ---------------------------------------------------------------------- collateral

#[test]
fn collateral_is_credited_from_the_token_only() {
    let mut w = World::new();
    let a = w.agent("scout", 5_000_000);
    assert_eq!(w.q.get_collateral(a).total.0, 5_000_000);
    assert_eq!(w.q.available_collateral(a).0, 5_000_000);
}

#[test]
#[should_panic(expected = "only the settlement token is accepted")]
fn other_tokens_are_refused_as_collateral() {
    let mut w = World::new();
    w.agent("scout", 0);
    w.as_account("fake-usdc.test.near");
    w.q.ft_on_transfer(account("scout").parse().unwrap(), U128(1), String::new());
}

#[test]
#[should_panic(expected = "the withdrawal delay has not passed")]
fn withdrawal_waits_for_the_delay() {
    let mut w = World::new();
    let a = w.agent("scout", 5_000_000);
    w.as_account(&account("scout"));
    w.q.request_withdrawal(a, U128(1_000_000));
    assert_eq!(w.q.available_collateral(a).0, 4_000_000);
    w.advance(60_000);
    w.as_account(&account("scout"));
    let _ = w.q.withdraw(a);
}

#[test]
fn withdrawal_pays_out_after_the_delay() {
    let mut w = World::new();
    let a = w.agent("scout", 5_000_000);
    w.as_account(&account("scout"));
    w.q.request_withdrawal(a, U128(1_000_000));
    w.advance(120_000);
    w.as_account(&account("scout"));
    let _ = w.q.withdraw(a);
    assert_eq!(w.q.get_collateral(a).total.0, 4_000_000);
    assert_eq!(w.q.get_collateral(a).pending_withdrawal.0, 0);
}

// ---------------------------------------------------------------------- posting and netting

#[test]
fn nets_a_cycle_to_zero() {
    let mut w = World::new();
    let (a, b, c) = (w.agent("a", 10_000), w.agent("b", 10_000), w.agent("c", 10_000));
    // a owes b 100, b owes c 100, c owes a 100: nobody owes anything.
    let ious = vec![w.iou(1, a, b, 100, 1), w.iou(1, b, c, 100, 1), w.iou(1, c, a, 100, 1)];
    w.post(1, ious);
    w.finalize(1);
    let e = w.q.get_epoch(1).unwrap();
    assert_eq!(e.status, EpochStatus::Sealed, "an epoch with no debtors seals at once");
    assert_eq!((e.iou_count, e.gross_volume.0, e.net_volume.0, e.plan.len()), (3, 300, 0, 0));
    assert_eq!(w.q.get_config().current_epoch, 2);
}

#[test]
fn net_positions_sum_to_zero_and_lock_collateral() {
    let mut w = World::new();
    let (a, b, c) = (w.agent("a", 10_000), w.agent("b", 10_000), w.agent("c", 10_000));
    let ious = vec![w.iou(1, a, b, 700, 1), w.iou(1, a, c, 300, 2), w.iou(1, b, c, 200, 1), w.iou(1, c, a, 150, 5)];
    w.post(1, ious);
    w.finalize(1);
    assert_eq!((net(&w, 1, a), net(&w, 1, b), net(&w, 1, c)), ("-850".to_string(), "500".to_string(), "350".to_string()));
    let e = w.q.get_epoch(1).unwrap();
    assert_eq!(e.status, EpochStatus::Finalized);
    assert_eq!((e.debtor_count, e.creditor_count, e.net_volume.0), (1, 2, 850));
    assert_eq!(
        e.plan,
        vec![Transfer { from: a, to: b, amount: U128(500) }, Transfer { from: a, to: c, amount: U128(350) }]
    );
    assert_eq!(w.q.get_collateral(a).locked.0, 850);
    assert_eq!(w.q.available_collateral(a).0, 9_150);
}

#[test]
fn chunks_accumulate_in_first_appearance_order() {
    let mut w = World::new();
    let (a, b, c) = (w.agent("a", 10_000), w.agent("b", 10_000), w.agent("c", 10_000));
    let first = vec![w.iou(1, a, c, 10, 1)];
    let second = vec![w.iou(1, a, b, 20, 2), w.iou(1, b, c, 5, 1)];
    w.post(1, first);
    w.post(1, second);
    let e = w.q.get_epoch(1).unwrap();
    assert_eq!(e.participants, vec![a, c, b]);
    assert_eq!(e.iou_count, 3);
}

#[test]
#[should_panic(expected = "bad IOU signature")]
fn an_iou_signed_by_someone_else_is_refused() {
    let mut w = World::new();
    let (a, b, c) = (w.agent("a", 10_000), w.agent("b", 10_000), w.agent("c", 10_000));
    let mut forged = w.iou(1, c, b, 100, 1);
    forged.buyer = a; // c's signature, presented as a's debt
    w.post(1, vec![forged]);
}

#[test]
#[should_panic(expected = "bad IOU signature")]
fn an_iou_altered_after_signing_is_refused() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 10_000));
    let mut iou = w.iou(1, a, b, 100, 1);
    iou.amount = U128(1);
    w.post(1, vec![iou]);
}

#[test]
#[should_panic(expected = "out of order or repeated")]
fn an_iou_cannot_be_posted_twice_in_an_epoch() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 10_000));
    let iou = w.iou(1, a, b, 100, 1);
    w.post(1, vec![iou.clone()]);
    w.post(1, vec![iou]);
}

#[test]
#[should_panic(expected = "IOU belongs to a different epoch")]
fn an_iou_cannot_be_replayed_in_a_later_epoch() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 10_000));
    let iou = w.iou(1, a, b, 100, 1);
    w.post(1, vec![iou.clone()]);
    w.finalize(1);
    w.post(2, vec![iou]);
}

#[test]
#[should_panic(expected = "nonce was already used in an earlier epoch")]
fn a_nonce_cannot_be_reused_in_a_later_epoch() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 10_000));
    let first = w.iou(1, a, b, 100, 7);
    w.post(1, vec![first]);
    w.finalize(1);
    let again = w.iou(2, a, b, 100, 7);
    w.post(2, vec![again]);
}

#[test]
#[should_panic(expected = "an agent cannot owe itself")]
fn self_dealing_is_refused() {
    let mut w = World::new();
    let a = w.agent("a", 10_000);
    let iou = w.iou(1, a, a, 100, 1);
    w.post(1, vec![iou]);
}

#[test]
#[should_panic(expected = "only the clearer may call this")]
fn only_the_clearer_posts() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 10_000));
    let iou = w.iou(1, a, b, 100, 1);
    w.as_account(&account("a"));
    w.q.post_ious(1, vec![iou]);
}

#[test]
#[should_panic(expected = "free collateral")]
fn finalize_refuses_an_uncovered_debtor() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 50), w.agent("b", 0));
    let iou = w.iou(1, a, b, 100, 1);
    w.post(1, vec![iou]);
    w.finalize(1);
}

#[test]
#[should_panic(expected = "positions do not match the claimed hash")]
fn finalize_refuses_a_wrong_claim() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 0));
    let iou = w.iou(1, a, b, 100, 1);
    w.post(1, vec![iou]);
    w.as_account(CLEARER);
    let e = w.q.get_epoch(1).unwrap();
    w.q.finalize_epoch(1, e.iou_set_hash, H1.into());
}

#[test]
#[should_panic(expected = "epoch is already finalized")]
fn posting_into_a_finalized_epoch_is_refused() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 0));
    let first = w.iou(1, a, b, 100, 1);
    w.post(1, vec![first]);
    w.finalize(1);
    w.q.current_epoch = 1; // even if the pointer were wrong, the status check holds
    let late = w.iou(1, a, b, 100, 2);
    w.post(1, vec![late]);
}

#[test]
fn held_out_ious_stay_out_until_carried() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 0));
    let disputed = w.iou(1, a, b, 400, 1);
    let fine = w.iou(1, a, b, 100, 2);
    let digest = hex32(&iou_digest_of(&disputed, TOKEN, CONTRACT));
    w.as_account(CLEARER);
    w.q.hold_out(1, vec![digest.clone()]);
    w.post(1, vec![fine]);
    w.finalize(1);
    assert_eq!(net(&w, 1, a), "-100");

    // The dispute is rejected: the IOU is carried into epoch 2.
    w.as_account(CLEARER);
    w.q.post_carried(2, disputed);
    assert_eq!(w.q.held_out_epoch(digest), 0);
    w.finalize(2);
    assert_eq!(net(&w, 2, a), "-400");
    assert_eq!(w.q.get_epoch(2).unwrap().carried_count, 1);
}

#[test]
#[should_panic(expected = "IOU is held out by an open dispute")]
fn a_held_out_iou_cannot_be_posted_normally() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 0));
    let disputed = w.iou(1, a, b, 400, 1);
    w.as_account(CLEARER);
    w.q.hold_out(1, vec![hex32(&iou_digest_of(&disputed, TOKEN, CONTRACT))]);
    w.post(1, vec![disputed]);
}

#[test]
#[should_panic(expected = "IOU is not held out from an earlier epoch")]
fn a_released_iou_can_never_be_carried() {
    let mut w = World::new();
    let (a, b) = (w.agent("a", 10_000), w.agent("b", 0));
    let disputed = w.iou(1, a, b, 400, 1);
    let other = w.iou(1, a, b, 1, 2);
    let digest = hex32(&iou_digest_of(&disputed, TOKEN, CONTRACT));
    w.as_account(CLEARER);
    w.q.hold_out(1, vec![digest.clone()]);
    w.post(1, vec![other]);
    w.finalize(1);
    w.as_account(CLEARER);
    w.q.release_held_out(digest);
    w.q.post_carried(2, disputed);
}

#[test]
fn settlement_plan_pays_every_creditor_exactly() {
    let plan = settlement_plan(&[(1, 500), (2, 300), (3, 200)], &[(4, 250), (5, 750)]);
    let paid_to = |id: AgentId| plan.iter().filter(|t| t.to == id).map(|t| t.amount.0).sum::<u128>();
    let paid_by = |id: AgentId| plan.iter().filter(|t| t.from == id).map(|t| t.amount.0).sum::<u128>();
    assert_eq!((paid_to(4), paid_to(5)), (250, 750));
    assert_eq!((paid_by(1), paid_by(2), paid_by(3)), (500, 300, 200));
    assert!(plan.len() <= 4, "at most debtors + creditors - 1 transfers");
}

// ---------------------------------------------------------------------- settlement

fn owing_world() -> (World, AgentId, AgentId, AgentId) {
    let mut w = World::new();
    let (a, b, c) = (w.agent("a", 10_000), w.agent("b", 10_000), w.agent("c", 10_000));
    let ious = vec![w.iou(1, a, b, 700, 1), w.iou(1, a, c, 300, 2), w.iou(1, b, c, 200, 1), w.iou(1, c, a, 150, 5)];
    w.post(1, ious);
    w.finalize(1);
    (w, a, b, c)
}

#[test]
fn settlement_through_the_verifier_seals_the_epoch() {
    let (mut w, a, _, _) = owing_world();
    w.as_account("anyone.test.near");
    let signed = w.intent("a", &[("b", 500), ("c", 350)]);
    let _ = w.q.settle(1, vec![signed]);
    assert_eq!(w.q.get_position(1, a).unwrap().state, PositionState::Submitted);

    w.as_with(CONTRACT, vec![PromiseResult::Successful(vec![])]);
    assert!(w.q.on_settled(1, vec![a]));
    assert_eq!(w.q.get_position(1, a).unwrap().state, PositionState::Settled);
    assert_eq!(w.q.get_collateral(a).locked.0, 0);
    let e = w.q.get_epoch(1).unwrap();
    assert_eq!(e.status, EpochStatus::Sealed);
    assert_ne!(e.receipt_hash, ZERO_HEX);
}

#[test]
fn a_refused_batch_leaves_the_debt_open() {
    let (mut w, a, _, _) = owing_world();
    w.as_account("anyone.test.near");
    let signed = w.intent("a", &[("b", 500), ("c", 350)]);
    let _ = w.q.settle(1, vec![signed]);
    w.as_with(CONTRACT, vec![PromiseResult::Failed]);
    assert!(!w.q.on_settled(1, vec![a]));
    assert_eq!(w.q.get_position(1, a).unwrap().state, PositionState::Owes);
    assert_eq!(w.q.get_collateral(a).locked.0, 850);
    assert_eq!(w.q.get_epoch(1).unwrap().status, EpochStatus::Finalized);
}

#[test]
#[should_panic(expected = "transfer amount does not match the plan")]
fn settlement_must_pay_the_exact_debt() {
    let (mut w, _, _, _) = owing_world();
    let signed = w.intent("a", &[("b", 500), ("c", 349)]);
    let _ = w.q.settle(1, vec![signed]);
}

#[test]
#[should_panic(expected = "transfer receiver does not match the plan")]
fn settlement_must_pay_the_planned_creditor() {
    let (mut w, _, _, _) = owing_world();
    let signed = w.intent("a", &[("c", 500), ("b", 350)]);
    let _ = w.q.settle(1, vec![signed]);
}

#[test]
#[should_panic(expected = "intents do not match the settlement plan")]
fn settlement_cannot_skip_a_creditor() {
    let (mut w, _, _, _) = owing_world();
    let signed = w.intent("a", &[("b", 500)]);
    let _ = w.q.settle(1, vec![signed]);
}

#[test]
#[should_panic(expected = "signer has no open debt")]
fn a_creditor_cannot_settle() {
    let (mut w, _, _, _) = owing_world();
    let signed = w.intent("b", &[("c", 1)]);
    let _ = w.q.settle(1, vec![signed]);
}

#[test]
#[should_panic(expected = "signer has no open debt")]
fn a_debt_cannot_be_submitted_twice() {
    let (mut w, _, _, _) = owing_world();
    let signed = w.intent("a", &[("b", 500), ("c", 350)]);
    let _ = w.q.settle(1, vec![signed.clone()]);
    let _ = w.q.settle(1, vec![signed]);
}

#[test]
#[should_panic(expected = "the settlement deadline has not passed")]
fn default_waits_for_the_deadline() {
    let (mut w, a, _, _) = owing_world();
    w.q.declare_default(1, a);
}

#[test]
fn default_seizes_collateral_and_seals() {
    let (mut w, a, _, _) = owing_world();
    w.advance(60_001);
    w.as_account("anyone.test.near");
    w.q.declare_default(1, a);
    let c = w.q.get_collateral(a);
    assert_eq!((c.total.0, c.locked.0), (10_000 - 850, 0));
    assert_eq!(w.q.get_position(1, a).unwrap().state, PositionState::Defaulted);
    let e = w.q.get_epoch(1).unwrap();
    assert_eq!((e.status, e.default_count), (EpochStatus::Sealed, 1));
}

// ---------------------------------------------------------------------- rounds

fn salt(n: u8) -> String {
    hex32(&[n; 32])
}

fn commit(w: &mut World, round: u64, name: &str, id: AgentId, price: u128, n: u8) {
    w.as_account(&account(name));
    w.q.commit_bid(round, hex32(&commitment_of(round, id, price, &[n; 32])));
}

fn reveal(w: &mut World, round: u64, name: &str, price: u128, n: u8) {
    w.as_account(&account(name));
    w.q.reveal_bid(round, U128(price), salt(n));
}

fn tender(w: &mut World, pricing: Pricing, reserve: u128, min_rep: u16) -> u64 {
    w.as_account(&account("buyer"));
    w.q.open_round(RoundKind::Tender, pricing, "fact-check".into(), H1.into(), 1, U128(reserve), min_rep, 0, 5_000, 5_000)
}

fn market() -> (World, AgentId, AgentId, AgentId) {
    let mut w = World::new();
    w.agent("buyer", 0);
    let (s1, s2, s3) = (w.agent("s1", 0), w.agent("s2", 0), w.agent("s3", 0));
    (w, s1, s2, s3)
}

#[test]
fn second_price_tender_pays_the_lowest_losing_bid() {
    let (mut w, s1, s2, s3) = market();
    let r = tender(&mut w, Pricing::SecondPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 2_000, 1);
    commit(&mut w, r, "s2", s2, 1_500, 2);
    commit(&mut w, r, "s3", s3, 2_400, 3);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 2_000, 1);
    reveal(&mut w, r, "s2", 1_500, 2);
    reveal(&mut w, r, "s3", 2_400, 3);
    w.as_account("anyone.test.near");
    let closed = w.q.close_round(r); // every bid is revealed, so no need to wait
    assert_eq!(closed.status, RoundStatus::Closed);
    assert_eq!((closed.winner, closed.clearing_price.0), (Some(s2), 2_000));
    assert_eq!(closed.allocations[0].cost.0, 2_000);
}

#[test]
fn first_price_tender_pays_the_winning_bid() {
    let (mut w, s1, s2, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 2_000, 1);
    commit(&mut w, r, "s2", s2, 1_500, 2);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 2_000, 1);
    reveal(&mut w, r, "s2", 1_500, 2);
    let closed = w.q.close_round(r);
    assert_eq!((closed.winner, closed.clearing_price.0), (Some(s2), 1_500));
}

#[test]
fn a_lone_second_price_bidder_is_paid_the_reserve() {
    let (mut w, s1, _, _) = market();
    let r = tender(&mut w, Pricing::SecondPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 1_000, 1);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 1_000, 1);
    let closed = w.q.close_round(r);
    assert_eq!((closed.winner, closed.clearing_price.0), (Some(s1), 3_000));
}

#[test]
fn ties_go_to_the_earlier_commitment() {
    let (mut w, s1, s2, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    commit(&mut w, r, "s2", s2, 1_500, 2);
    commit(&mut w, r, "s1", s1, 1_500, 1);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 1_500, 1);
    reveal(&mut w, r, "s2", 1_500, 2);
    assert_eq!(w.q.close_round(r).winner, Some(s2));
}

#[test]
fn unrevealed_and_overpriced_bids_do_not_count() {
    let (mut w, s1, s2, s3) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 1_000, 1); // never reveals
    commit(&mut w, r, "s2", s2, 3_500, 2); // above the reserve
    commit(&mut w, r, "s3", s3, 2_900, 3);
    w.advance(5_000);
    reveal(&mut w, r, "s2", 3_500, 2);
    reveal(&mut w, r, "s3", 2_900, 3);
    w.advance(5_000);
    w.as_account("anyone.test.near");
    let closed = w.q.close_round(r);
    assert_eq!((closed.winner, closed.clearing_price.0), (Some(s3), 2_900));
}

#[test]
fn sellers_below_the_reputation_floor_are_skipped() {
    let (mut w, s1, s2, _) = market();
    w.as_account(CLEARER);
    w.q.record_epoch_scores(1, vec![s1], vec![650], H1.into());
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 700);
    commit(&mut w, r, "s1", s1, 1_000, 1);
    commit(&mut w, r, "s2", s2, 2_000, 2);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 1_000, 1);
    reveal(&mut w, r, "s2", 2_000, 2);
    assert_eq!(w.q.close_round(r).winner, Some(s2));
}

#[test]
fn a_round_without_valid_bids_is_void() {
    let (mut w, _, _, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    w.advance(10_000);
    w.as_account("anyone.test.near");
    let closed = w.q.close_round(r);
    assert_eq!(closed.status, RoundStatus::Void);
    assert_eq!(closed.winner, None);
}

#[test]
#[should_panic(expected = "reveal does not match the commitment")]
fn a_bid_cannot_change_after_commit() {
    let (mut w, s1, _, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 2_000, 1);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 1_999, 1);
}

#[test]
#[should_panic(expected = "the commit window has closed")]
fn late_bids_are_refused() {
    let (mut w, s1, _, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    w.advance(5_000);
    commit(&mut w, r, "s1", s1, 2_000, 1);
}

#[test]
#[should_panic(expected = "the commit window is still open")]
fn early_reveals_are_refused() {
    let (mut w, s1, _, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 2_000, 1);
    reveal(&mut w, r, "s1", 2_000, 1);
}

#[test]
#[should_panic(expected = "the round is still running")]
fn a_round_cannot_close_early() {
    let (mut w, s1, _, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 2_000, 1);
    w.advance(5_000);
    w.q.close_round(r);
}

#[test]
#[should_panic(expected = "a buyer in the round cannot bid in it")]
fn a_buyer_cannot_bid_on_its_own_round() {
    let (mut w, _, _, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    let buyer_id = w.q.agent_id_of(account("buyer").parse().unwrap()).unwrap();
    commit(&mut w, r, "buyer", buyer_id, 1, 1);
}

#[test]
fn group_buy_charges_each_buyer_only_its_share() {
    let (mut w, s1, s2, _) = market();
    let (b2, b3) = (w.agent("b2", 0), w.agent("b3", 0));
    w.as_account(&account("buyer"));
    let r = w.q.open_round(RoundKind::GroupBuy, Pricing::SecondPrice, "gpu-hour".into(), H1.into(), 10, U128(1_000), 0, 4_000, 5_000, 5_000);
    w.as_account(&account("b2"));
    w.q.join_round(r, 30, U128(900));
    w.as_account(&account("b3"));
    w.q.join_round(r, 5, U128(600)); // will not accept the clearing price
    w.advance(4_000);
    commit(&mut w, r, "s1", s1, 700, 1);
    commit(&mut w, r, "s2", s2, 800, 2);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 700, 1);
    reveal(&mut w, r, "s2", 800, 2);
    let closed = w.q.close_round(r);
    assert_eq!((closed.winner, closed.clearing_price.0, closed.total_quantity), (Some(s1), 800, 40));
    let costs: Vec<(AgentId, u128)> = closed.allocations.iter().map(|a| (a.buyer, a.cost.0)).collect();
    assert_eq!(costs, vec![(closed.opener, 8_000), (b2, 24_000)]);
    assert!(closed.allocations.iter().all(|a| a.buyer != b3));
    let bill: u128 = closed.allocations.iter().map(|a| a.cost.0).sum();
    assert_eq!(bill, closed.clearing_price.0 * closed.total_quantity as u128, "shares add up to the bill");
}

#[test]
#[should_panic(expected = "buyers are still joining")]
fn sellers_wait_for_the_join_window() {
    let (mut w, s1, _, _) = market();
    w.as_account(&account("buyer"));
    let r = w.q.open_round(RoundKind::GroupBuy, Pricing::FirstPrice, "gpu-hour".into(), H1.into(), 10, U128(1_000), 0, 4_000, 5_000, 5_000);
    commit(&mut w, r, "s1", s1, 700, 1);
}

#[test]
#[should_panic(expected = "the join window has closed")]
fn late_buyers_are_refused() {
    let (mut w, _, _, _) = market();
    w.agent("b2", 0);
    w.as_account(&account("buyer"));
    let r = w.q.open_round(RoundKind::GroupBuy, Pricing::FirstPrice, "gpu-hour".into(), H1.into(), 10, U128(1_000), 0, 4_000, 5_000, 5_000);
    w.advance(4_000);
    w.as_account(&account("b2"));
    w.q.join_round(r, 1, U128(900));
}

// ---------------------------------------------------------------------- storage

#[test]
fn prune_frees_old_epochs_and_rounds_only() {
    let (mut w, s1, s2, _) = market();
    let r = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    commit(&mut w, r, "s1", s1, 1_000, 1);
    commit(&mut w, r, "s2", s2, 2_000, 2);
    w.advance(5_000);
    reveal(&mut w, r, "s1", 1_000, 1);
    reveal(&mut w, r, "s2", 2_000, 2);
    w.q.close_round(r);
    let open = tender(&mut w, Pricing::FirstPrice, 3_000, 0);
    let (a, b) = (w.agent("pa", 10_000), w.agent("pb", 0));
    let iou = w.iou(1, a, b, 100, 1);
    w.post(1, vec![iou]);
    w.finalize(1);
    let a_owes = w.q.get_position(1, a).unwrap().state == PositionState::Owes;
    assert!(a_owes);

    // too young: nothing is pruned
    w.as_account(CLEARER);
    assert_eq!(w.q.prune(vec![1], vec![r, open]), (0, 0));

    // an hour later the closed round goes, the open round and the unsealed epoch stay
    w.advance(3_600_000);
    w.as_account(CLEARER);
    assert_eq!(w.q.prune(vec![1], vec![r, open]), (0, 1));
    assert!(w.q.get_round(r).is_none());
    assert!(w.q.get_round(open).is_some());
    assert!(w.q.get_epoch(1).is_some());

    // a sealed epoch goes with its positions
    w.q.declare_default(1, a);
    w.advance(PRUNE_AGE_MS);
    w.as_account(CLEARER);
    assert_eq!(w.q.prune(vec![1], vec![]), (1, 0));
    assert!(w.q.get_epoch(1).is_none());
    assert!(w.q.get_position(1, a).is_none());
}

#[test]
#[should_panic(expected = "only the clearer or the owner may prune")]
fn strangers_cannot_prune() {
    let mut w = World::new();
    w.as_account("anyone.test.near");
    w.q.prune(vec![1], vec![]);
}

// ---------------------------------------------------------------------- validation and scores

#[test]
fn a_staked_validator_answers_from_its_own_account() {
    let mut w = World::new();
    let seller = w.agent("rogue", 0);
    let arbiter = w.agent("arbiter", 1_000_000);
    w.as_account(CLEARER);
    w.q.validation_request(H1.into(), arbiter, seller, "https://x/dispute".into());
    w.as_account(&account("arbiter"));
    w.q.validation_response(H1.into(), 0, "https://x/verdict".into());
    assert_eq!(w.q.get_validation(H1.into()).unwrap().response, Some(0));
}

#[test]
#[should_panic(expected = "validator stake is below the minimum")]
fn an_unstaked_validator_cannot_answer() {
    let mut w = World::new();
    let seller = w.agent("rogue", 0);
    let arbiter = w.agent("arbiter", 999_999);
    w.as_account(CLEARER);
    w.q.validation_request(H1.into(), arbiter, seller, String::new());
    w.as_account(&account("arbiter"));
    w.q.validation_response(H1.into(), 0, String::new());
}

#[test]
#[should_panic(expected = "scores for this epoch are already recorded")]
fn scores_are_written_once_per_epoch() {
    let mut w = World::new();
    let a = w.agent("a", 0);
    w.as_account(CLEARER);
    w.q.record_epoch_scores(1, vec![a], vec![800], H1.into());
    w.q.record_epoch_scores(1, vec![a], vec![100], H1.into());
}

#[test]
fn the_iou_message_is_canonical_json() {
    let iou = IouInput {
        buyer: 3,
        seller: 7,
        amount: U128(4_000),
        job_hash: H1.into(),
        quote_hash: H2.into(),
        epoch: 12,
        nonce: U64(99),
        signature: String::new(),
    };
    assert_eq!(
        iou_message(&iou, "usdc.quorum.testnet"),
        format!(r#"{{"amount":"4000","buyer":"3","epoch":"12","jobHash":"{H1}","nonce":"99","quoteHash":"{H2}","seller":"7","token":"usdc.quorum.testnet","type":"IOU"}}"#)
    );
}

/// The same inputs and outputs are asserted in Blockchain/core/test/messages.test.ts
/// ("parity with the contract"), so the contract and the TypeScript mirror cannot drift.
#[test]
fn parity_vectors() {
    testing_env!(VMContextBuilder::new().build());
    let iou = IouInput {
        buyer: 3,
        seller: 7,
        amount: U128(4_000),
        job_hash: H1.into(),
        quote_hash: H2.into(),
        epoch: 12,
        nonce: U64(99),
        signature: String::new(),
    };
    assert_eq!(
        hex32(&iou_digest_of(&iou, "usdc.quorum.testnet", "clearing.quorum.test.near")),
        "0x34d146f21c4c818f5cedd13235064fe1f3b7be13d6a675ff49806df1906fb408"
    );
    assert_eq!(
        hex32(&commitment_of(5, 9, 123_456, &unhex32(H1))),
        "0xec43a5cec5634f7bf728b67c814bf5e031339eab7baccf3db6258234518eb1d2"
    );
    let zero = unhex32(ZERO_HEX);
    assert_eq!(
        hex32(&hash_parts(&[&zero, &unhex32(H1)])),
        "0x8878b15a7d6a3a4f464e8f9f42591dbc0cf4bedea0ec309003d2b2ee53655ef8"
    );
    assert_eq!(
        hex32(&hash_parts(&[&zero, &3u64.to_le_bytes(), &700u128.to_le_bytes(), &1_550u128.to_le_bytes()])),
        "0x8e81152db5a5f597b1de295375a44807bcb48b3f90acf4aa51030abe4a62a061"
    );
    let key = SigningKey::from_bytes(&[7; 32]);
    assert_eq!(
        format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()),
        "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"
    );
}
