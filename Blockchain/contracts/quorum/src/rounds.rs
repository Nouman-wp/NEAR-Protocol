//! Sealed-bid rounds: how a swarm discovers a price.
//!
//! A round is a reverse auction. Buyers state demand, sellers commit to a hidden price,
//! then reveal it, and the contract picks the winner and the clearing price by a fixed
//! rule. Every step is a transaction from the agent's own account, so the whole round can
//! be read back from the chain, agent by agent.
//!
//!   tender     one buyer puts one job out to competing sellers
//!   group buy  many buyers pool their demand and buy from one seller at one unit price
use crate::util::*;
use crate::*;

pub const MAX_BUYERS: usize = 64;
pub const MAX_BIDS: usize = 32;
const MIN_WINDOW_MS: u64 = 1_000;
const MAX_WINDOW_MS: u64 = 3_600_000;
const BID_DOMAIN: &[u8] = b"quorum.bid.v1";

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum RoundKind {
    Tender,
    GroupBuy,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Pricing {
    /// The winner is paid its own bid.
    FirstPrice,
    /// The winner is paid the lowest losing bid (the reserve if it bid alone), so bidding
    /// its true cost is a seller's best strategy.
    SecondPrice,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum RoundStatus {
    Open,
    Closed,
    /// No valid bid, or no buyer could afford the clearing price.
    Void,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Demand {
    pub buyer: AgentId,
    pub quantity: u32,
    /// The most this buyer pays per unit.
    pub max_price: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Bid {
    pub seller: AgentId,
    pub commitment: String,
    pub committed_at: u64,
    /// Unit price, known only after the reveal.
    pub price: Option<U128>,
    pub revealed_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Allocation {
    pub buyer: AgentId,
    pub quantity: u32,
    /// quantity x clearing price: this buyer's share of the bill, and nothing more.
    pub cost: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Round {
    pub id: u64,
    pub kind: RoundKind,
    pub pricing: Pricing,
    pub status: RoundStatus,
    pub opener: AgentId,
    pub service: String,
    /// Hash of the full job specification the bids are for.
    pub spec_hash: String,
    /// Bids above this unit price are invalid.
    pub reserve_price: U128,
    /// Sellers scoring below this (0..1000) are invalid.
    pub min_reputation: u16,
    pub opened_at: u64,
    pub join_deadline: u64,
    pub commit_deadline: u64,
    pub reveal_deadline: u64,
    pub closed_at: u64,
    pub demand: Vec<Demand>,
    pub bids: Vec<Bid>,
    pub winner: Option<AgentId>,
    pub clearing_price: U128,
    pub total_quantity: u32,
    pub allocations: Vec<Allocation>,
    pub void_reason: String,
}

#[near]
impl Quorum {
    /// Open a round from the buyer's own account. For a tender the join window is skipped
    /// and sellers can commit at once. Windows are in milliseconds.
    #[allow(clippy::too_many_arguments)]
    pub fn open_round(
        &mut self,
        kind: RoundKind,
        pricing: Pricing,
        service: String,
        spec_hash: String,
        quantity: u32,
        reserve_price: U128,
        min_reputation: u16,
        join_ms: u64,
        commit_ms: u64,
        reveal_ms: u64,
    ) -> u64 {
        let opener = self.caller_agent();
        require!(!service.is_empty() && service.len() <= 64, "service name out of range");
        unhex32(&spec_hash);
        require!(quantity > 0, "quantity must be positive");
        require!(reserve_price.0 > 0 && reserve_price.0 <= MAX_IOU_AMOUNT, "reserve price out of range");
        require!(min_reputation <= 1000, "reputation floor out of range");
        check_round_window(commit_ms);
        check_round_window(reveal_ms);
        let join_ms = match kind {
            RoundKind::Tender => 0,
            RoundKind::GroupBuy => {
                check_round_window(join_ms);
                join_ms
            }
        };

        let now = env::block_timestamp_ms();
        self.round_count += 1;
        let id = self.round_count;
        let round = Round {
            id,
            kind,
            pricing,
            status: RoundStatus::Open,
            opener: opener.id,
            service,
            spec_hash,
            reserve_price,
            min_reputation,
            opened_at: now,
            join_deadline: now + join_ms,
            commit_deadline: now + join_ms + commit_ms,
            reveal_deadline: now + join_ms + commit_ms + reveal_ms,
            closed_at: 0,
            demand: vec![Demand { buyer: opener.id, quantity, max_price: reserve_price }],
            bids: Vec::new(),
            winner: None,
            clearing_price: U128(0),
            total_quantity: quantity,
            allocations: Vec::new(),
            void_reason: String::new(),
        };
        emit(
            "round_opened",
            serde_json::json!({
                "round": id, "kind": kind, "pricing": pricing, "opener": opener.id, "service": round.service, "spec_hash": round.spec_hash,
                "quantity": quantity, "reserve_price": reserve_price, "min_reputation": min_reputation,
                "join_deadline": round.join_deadline, "commit_deadline": round.commit_deadline, "reveal_deadline": round.reveal_deadline
            }),
        );
        self.rounds.insert(id, round);
        id
    }

    /// Add demand to a group buy, from the buyer's own account, before the join deadline.
    pub fn join_round(&mut self, round_id: u64, quantity: u32, max_price: U128) {
        let buyer = self.caller_agent();
        let mut r = self.open_round_state(round_id);
        require!(r.kind == RoundKind::GroupBuy, "only a group buy can be joined");
        require!(env::block_timestamp_ms() < r.join_deadline, "the join window has closed");
        require!(quantity > 0, "quantity must be positive");
        require!(max_price.0 > 0 && max_price.0 <= r.reserve_price.0, "max price must be positive and at most the reserve");
        require!(r.demand.len() < MAX_BUYERS, "the round is full");
        require!(r.demand.iter().all(|d| d.buyer != buyer.id), "buyer already joined");
        r.demand.push(Demand { buyer: buyer.id, quantity, max_price });
        r.total_quantity += quantity;
        emit("round_joined", serde_json::json!({ "round": round_id, "buyer": buyer.id, "quantity": quantity, "max_price": max_price, "total_quantity": r.total_quantity }));
        self.rounds.insert(round_id, r);
    }

    /// Commit to a hidden unit price, from the seller's own account. The commitment is
    /// sha256("quorum.bid.v1" ++ round ++ seller ++ price ++ salt), integers little-endian.
    pub fn commit_bid(&mut self, round_id: u64, commitment: String) {
        let seller = self.caller_agent();
        let mut r = self.open_round_state(round_id);
        let now = env::block_timestamp_ms();
        require!(now >= r.join_deadline, "buyers are still joining");
        require!(now < r.commit_deadline, "the commit window has closed");
        unhex32(&commitment);
        require!(r.demand.iter().all(|d| d.buyer != seller.id), "a buyer in the round cannot bid in it");
        require!(r.bids.iter().all(|b| b.seller != seller.id), "seller already committed");
        require!(r.bids.len() < MAX_BIDS, "the round has too many bids");
        emit("bid_committed", serde_json::json!({ "round": round_id, "seller": seller.id, "commitment": commitment }));
        r.bids.push(Bid { seller: seller.id, commitment, committed_at: now, price: None, revealed_at: 0 });
        self.rounds.insert(round_id, r);
    }

    /// Open the commitment. A price that does not hash to it is refused, so a bid cannot
    /// change after the seller has seen how many competitors committed.
    pub fn reveal_bid(&mut self, round_id: u64, price: U128, salt: String) {
        let seller = self.caller_agent();
        let mut r = self.open_round_state(round_id);
        let now = env::block_timestamp_ms();
        require!(now >= r.commit_deadline, "the commit window is still open");
        require!(now < r.reveal_deadline, "the reveal window has closed");
        let bid = r.bids.iter_mut().find(|b| b.seller == seller.id).unwrap_or_else(|| env::panic_str("seller did not commit"));
        require!(bid.price.is_none(), "bid already revealed");
        let expected = commitment_of(round_id, seller.id, price.0, &unhex32(&salt));
        require!(hex32(&expected) == bid.commitment, "reveal does not match the commitment");
        bid.price = Some(price);
        bid.revealed_at = now;
        emit("bid_revealed", serde_json::json!({ "round": round_id, "seller": seller.id, "price": price }));
        self.rounds.insert(round_id, r);
    }

    /// Close the round. Anyone may call this once the reveal window has passed, or sooner
    /// if every committed bid is already revealed. The result follows from the bids alone:
    /// the caller has no say in it.
    pub fn close_round(&mut self, round_id: u64) -> Round {
        let mut r = self.open_round_state(round_id);
        let now = env::block_timestamp_ms();
        let all_revealed = r.bids.iter().all(|b| b.price.is_some());
        require!(
            now >= r.reveal_deadline || (now >= r.commit_deadline && all_revealed),
            "the round is still running"
        );

        // Valid bids, cheapest first. Ties go to the earlier commitment.
        let mut valid: Vec<(u128, usize, AgentId)> = r
            .bids
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.price.map(|p| (p.0, i, b.seller)))
            .filter(|(price, _, seller)| *price > 0 && *price <= r.reserve_price.0 && self.reputation_of(*seller) >= r.min_reputation)
            .collect();
        valid.sort();

        r.closed_at = now;
        if valid.is_empty() {
            r.status = RoundStatus::Void;
            r.void_reason = "no valid bid".to_string();
        } else {
            let clearing = match r.pricing {
                Pricing::FirstPrice => valid[0].0,
                Pricing::SecondPrice => valid.get(1).map(|b| b.0).unwrap_or(r.reserve_price.0),
            };
            let allocations: Vec<Allocation> = r
                .demand
                .iter()
                .filter(|d| d.max_price.0 >= clearing)
                .map(|d| Allocation { buyer: d.buyer, quantity: d.quantity, cost: U128(clearing * d.quantity as u128) })
                .collect();
            if allocations.is_empty() {
                r.status = RoundStatus::Void;
                r.void_reason = "no buyer accepts the clearing price".to_string();
            } else {
                r.status = RoundStatus::Closed;
                r.winner = Some(valid[0].2);
                r.clearing_price = U128(clearing);
                r.total_quantity = allocations.iter().map(|a| a.quantity).sum();
                r.allocations = allocations;
            }
        }
        emit(
            "round_closed",
            serde_json::json!({
                "round": round_id, "status": r.status, "winner": r.winner, "clearing_price": r.clearing_price,
                "total_quantity": r.total_quantity, "bids": r.bids.len(), "valid_bids": valid.len(),
                "allocations": r.allocations, "void_reason": r.void_reason
            }),
        );
        self.rounds.insert(round_id, r.clone());
        r
    }

    pub fn get_round(&self, round_id: u64) -> Option<Round> {
        self.rounds.get(&round_id).cloned()
    }

    pub fn get_rounds(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Round> {
        let from = from.unwrap_or(1).max(1);
        let to = (from + limit.unwrap_or(50).min(100)).min(self.round_count + 1);
        (from..to).filter_map(|id| self.rounds.get(&id).cloned()).collect()
    }

    /// The commitment a seller should post for a bid. A view, so SDKs can cross-check.
    pub fn bid_commitment(&self, round_id: u64, seller: AgentId, price: U128, salt: String) -> String {
        hex32(&commitment_of(round_id, seller, price.0, &unhex32(&salt)))
    }
}

impl Quorum {
    fn open_round_state(&self, round_id: u64) -> Round {
        let r = self.rounds.get(&round_id).cloned().unwrap_or_else(|| env::panic_str("unknown round"));
        require!(r.status == RoundStatus::Open, "the round is closed");
        r
    }
}

pub fn commitment_of(round_id: u64, seller: AgentId, price: u128, salt: &Hash) -> Hash {
    hash_parts(&[BID_DOMAIN, &round_id.to_le_bytes(), &seller.to_le_bytes(), &price.to_le_bytes(), salt])
}

fn check_round_window(ms: u64) {
    require!((MIN_WINDOW_MS..=MAX_WINDOW_MS).contains(&ms), "round windows must be between 1 second and 1 hour");
}
