//! Quorum coordinator: the on-chain half of a market and clearing house for agent swarms.
//!
//! One contract holds the registry, collateral, rounds, epochs and reputation, because NEAR's
//! cross-contract calls are asynchronous and netting needs identity, collateral and
//! positions in a single atomic step.
//!
//!   * registry    every agent is its own NEAR account with a numeric id and a signing key
//!   * rounds      sealed-bid tenders and group buys: commit, reveal, deterministic close
//!   * epochs      every signed IOU is verified here, positions are netted and must sum to zero
//!   * settlement  net debts are paid as NEAR Intents `transfer`s that the contract checks
//!                 against its own plan before it forwards them to the verifier
//!   * collateral  backs every net debt; a missed deadline is covered from it
//!   * reputation  one score per agent per epoch, written by the clearer
//!
//! The rules are specified in RULES.md at the repository root.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

mod epochs;
mod rounds;
#[cfg(test)]
mod tests;
mod util;

pub use epochs::*;
pub use rounds::*;
use util::*;

pub type AgentId = u64;

/// Score of an agent with no history, on the 0..1000 scale (see Blockchain/core reputation).
pub const DEFAULT_REPUTATION: u16 = 900;
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Agents,
    AgentByAccount,
    Collateral,
    Reputation,
    LastNonce,
    HeldOut,
    Epochs,
    Positions,
    Rounds,
    Validations,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum AgentStatus {
    Active,
    Paused,
    Retired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub id: AgentId,
    /// The agent's own NEAR account. Every on-chain action of the agent comes from it.
    pub account: AccountId,
    /// Who may pause the agent and withdraw its collateral, next to the agent itself.
    pub operator: AccountId,
    /// The ed25519 key that signs the agent's off-chain messages (NEP-413).
    pub public_key: PublicKey,
    /// Where the agent card is served.
    pub uri: String,
    pub status: AgentStatus,
    pub registered_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Collateral {
    pub total: U128,
    pub locked: U128,
    pub pending_withdrawal: U128,
    pub withdrawal_requested_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Validation {
    pub request_hash: String,
    pub validator: AgentId,
    pub agent: AgentId,
    pub uri: String,
    pub requested_at: u64,
    pub responded_at: u64,
    /// 0..100, where 100 means the challenged work was fine. `None` until the validator rules.
    pub response: Option<u8>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub clearer: AccountId,
    pub token: AccountId,
    pub intents: AccountId,
    pub settlement_window_ms: u64,
    pub withdrawal_delay_ms: u64,
    pub min_validator_stake: U128,
    pub current_epoch: u64,
    pub agent_count: u64,
    pub round_count: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Quorum {
    owner: AccountId,
    /// The clearing service's account: posts IOUs, finalises epochs, writes scores.
    clearer: AccountId,
    /// The NEP-141 stablecoin every IOU is denominated in.
    token: AccountId,
    /// The NEAR Intents verifier that executes settlement transfers.
    intents: AccountId,
    settlement_window_ms: u64,
    withdrawal_delay_ms: u64,
    min_validator_stake: u128,

    agents: LookupMap<AgentId, Agent>,
    agent_by_account: LookupMap<AccountId, AgentId>,
    agent_count: u64,
    collateral: LookupMap<AgentId, Collateral>,
    reputation: LookupMap<AgentId, u16>,
    last_scored_epoch: u64,

    current_epoch: u64,
    epochs: LookupMap<u64, Epoch>,
    positions: LookupMap<(u64, AgentId), Position>,
    last_nonce: LookupMap<AgentId, u64>,
    /// IOU digest -> the epoch it was held out of while a dispute is open.
    held_out: LookupMap<Hash, u64>,

    rounds: LookupMap<u64, Round>,
    round_count: u64,

    validations: LookupMap<Hash, Validation>,
}

#[near]
impl Quorum {
    #[init]
    pub fn new(
        owner: AccountId,
        clearer: AccountId,
        token: AccountId,
        intents: AccountId,
        settlement_window_ms: u64,
        withdrawal_delay_ms: u64,
        min_validator_stake: U128,
    ) -> Self {
        check_window(settlement_window_ms);
        Self {
            owner,
            clearer,
            token,
            intents,
            settlement_window_ms,
            withdrawal_delay_ms,
            min_validator_stake: min_validator_stake.0,
            agents: LookupMap::new(Key::Agents),
            agent_by_account: LookupMap::new(Key::AgentByAccount),
            agent_count: 0,
            collateral: LookupMap::new(Key::Collateral),
            reputation: LookupMap::new(Key::Reputation),
            last_scored_epoch: 0,
            current_epoch: 1,
            epochs: LookupMap::new(Key::Epochs),
            positions: LookupMap::new(Key::Positions),
            last_nonce: LookupMap::new(Key::LastNonce),
            held_out: LookupMap::new(Key::HeldOut),
            rounds: LookupMap::new(Key::Rounds),
            round_count: 0,
            validations: LookupMap::new(Key::Validations),
        }
    }

    // ------------------------------------------------------------------ admin (minimal)

    pub fn set_clearer(&mut self, clearer: AccountId) {
        self.only_owner();
        emit("clearer_changed", serde_json::json!({ "clearer": clearer }));
        self.clearer = clearer;
    }

    pub fn set_settlement_window(&mut self, window_ms: u64) {
        self.only_owner();
        check_window(window_ms);
        self.settlement_window_ms = window_ms;
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            clearer: self.clearer.clone(),
            token: self.token.clone(),
            intents: self.intents.clone(),
            settlement_window_ms: self.settlement_window_ms,
            withdrawal_delay_ms: self.withdrawal_delay_ms,
            min_validator_stake: U128(self.min_validator_stake),
            current_epoch: self.current_epoch,
            agent_count: self.agent_count,
            round_count: self.round_count,
        }
    }

    // ------------------------------------------------------------------ registry

    /// Register the calling account as an agent. The signing key defaults to the key
    /// that signed this transaction; the operator defaults to the agent itself.
    pub fn register(&mut self, uri: String, public_key: Option<PublicKey>, operator: Option<AccountId>) -> AgentId {
        let account = env::predecessor_account_id();
        require!(self.agent_by_account.get(&account).is_none(), "account is already registered");
        require!(uri.len() <= 512, "uri is too long");
        let public_key = public_key.unwrap_or_else(env::signer_account_pk);
        ed25519_bytes(&public_key); // refuses other curves
        self.agent_count += 1;
        let id = self.agent_count;
        let agent = Agent {
            id,
            operator: operator.unwrap_or_else(|| account.clone()),
            account: account.clone(),
            public_key,
            uri,
            status: AgentStatus::Active,
            registered_at: env::block_timestamp_ms(),
        };
        emit(
            "agent_registered",
            serde_json::json!({ "id": id, "account": agent.account, "operator": agent.operator, "public_key": agent.public_key, "uri": agent.uri }),
        );
        self.agent_by_account.insert(account, id);
        self.agents.insert(id, agent);
        id
    }

    pub fn set_uri(&mut self, agent_id: AgentId, uri: String) {
        require!(uri.len() <= 512, "uri is too long");
        let mut a = self.controlled_agent(agent_id);
        a.uri = uri;
        self.agents.insert(agent_id, a);
    }

    /// Rotate the message-signing key. IOUs signed with the old key stop verifying.
    pub fn set_public_key(&mut self, agent_id: AgentId, public_key: PublicKey) {
        ed25519_bytes(&public_key);
        let mut a = self.controlled_agent(agent_id);
        emit("agent_key_changed", serde_json::json!({ "id": agent_id, "public_key": public_key }));
        a.public_key = public_key;
        self.agents.insert(agent_id, a);
    }

    pub fn set_status(&mut self, agent_id: AgentId, status: AgentStatus) {
        let mut a = self.controlled_agent(agent_id);
        require!(a.status != AgentStatus::Retired, "a retired agent stays retired");
        emit("agent_status_changed", serde_json::json!({ "id": agent_id, "status": status }));
        a.status = status;
        self.agents.insert(agent_id, a);
    }

    pub fn get_agent(&self, agent_id: AgentId) -> Option<Agent> {
        self.agents.get(&agent_id).cloned()
    }

    pub fn agent_id_of(&self, account_id: AccountId) -> Option<AgentId> {
        self.agent_by_account.get(&account_id).copied()
    }

    pub fn get_agents(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Agent> {
        let from = from.unwrap_or(1).max(1);
        let to = (from + limit.unwrap_or(100).min(200)).min(self.agent_count + 1);
        (from..to).filter_map(|id| self.agents.get(&id).cloned()).collect()
    }

    // ------------------------------------------------------------------ collateral

    /// NEP-141 receiver. A transfer of the settlement token tops up collateral for the
    /// agent named in `msg` (a decimal id), or for the sender's own agent when `msg` is empty.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(env::predecessor_account_id() == self.token, "only the settlement token is accepted");
        let agent_id: AgentId = if msg.is_empty() {
            *self.agent_by_account.get(&sender_id).unwrap_or_else(|| env::panic_str("sender is not a registered agent"))
        } else {
            msg.parse().unwrap_or_else(|_| env::panic_str("msg must be an agent id"))
        };
        require!(self.agents.get(&agent_id).is_some(), "unknown agent");
        let mut c = self.collateral_of(agent_id);
        c.total.0 += amount.0;
        emit("collateral_deposited", serde_json::json!({ "agent": agent_id, "amount": amount, "total": c.total, "from": sender_id }));
        self.collateral.insert(agent_id, c);
        U128(0)
    }

    /// Step one of a withdrawal. The amount stops backing new debt at once and can be
    /// taken out after the delay, which is longer than an epoch.
    pub fn request_withdrawal(&mut self, agent_id: AgentId, amount: U128) {
        self.controlled_agent(agent_id);
        let mut c = self.collateral_of(agent_id);
        require!(amount.0 > 0, "amount must be positive");
        require!(c.pending_withdrawal.0 == 0, "a withdrawal is already pending");
        require!(available(&c) >= amount.0, "not enough free collateral");
        c.pending_withdrawal = amount;
        c.withdrawal_requested_at = env::block_timestamp_ms();
        emit("withdrawal_requested", serde_json::json!({ "agent": agent_id, "amount": amount }));
        self.collateral.insert(agent_id, c);
    }

    pub fn cancel_withdrawal(&mut self, agent_id: AgentId) {
        self.controlled_agent(agent_id);
        let mut c = self.collateral_of(agent_id);
        c.pending_withdrawal = U128(0);
        c.withdrawal_requested_at = 0;
        self.collateral.insert(agent_id, c);
    }

    /// Step two: pay the pending amount to the caller once the delay has passed.
    pub fn withdraw(&mut self, agent_id: AgentId) -> Promise {
        self.controlled_agent(agent_id);
        let mut c = self.collateral_of(agent_id);
        let amount = c.pending_withdrawal.0;
        require!(amount > 0, "no withdrawal is pending");
        require!(
            env::block_timestamp_ms() >= c.withdrawal_requested_at + self.withdrawal_delay_ms,
            "the withdrawal delay has not passed"
        );
        // Collateral locked since the request stays: pay out only what is still free.
        let free = c.total.0 - c.locked.0;
        let pay = amount.min(free);
        require!(pay > 0, "collateral is locked behind an open debt");
        c.total.0 -= pay;
        c.pending_withdrawal = U128(0);
        c.withdrawal_requested_at = 0;
        self.collateral.insert(agent_id, c);
        let to = env::predecessor_account_id();
        emit("collateral_withdrawn", serde_json::json!({ "agent": agent_id, "amount": U128(pay), "to": to }));
        let args = serde_json::json!({ "receiver_id": to, "amount": U128(pay) }).to_string().into_bytes();
        Promise::new(self.token.clone()).function_call("ft_transfer".to_string(), args, NearToken::from_yoctonear(1), GAS_FT_TRANSFER)
    }

    pub fn get_collateral(&self, agent_id: AgentId) -> Collateral {
        self.collateral_of(agent_id)
    }

    /// Collateral that can back new debt: total minus locked minus a pending withdrawal.
    pub fn available_collateral(&self, agent_id: AgentId) -> U128 {
        U128(available(&self.collateral_of(agent_id)))
    }

    // ------------------------------------------------------------------ reputation

    /// Write one score (0..1000) per agent for an epoch. Epochs must strictly increase.
    pub fn record_epoch_scores(&mut self, epoch: u64, agent_ids: Vec<AgentId>, scores: Vec<u16>, details_hash: String) {
        self.only_clearer();
        require!(agent_ids.len() == scores.len(), "length mismatch");
        require!(epoch > self.last_scored_epoch, "scores for this epoch are already recorded");
        unhex32(&details_hash);
        for (id, score) in agent_ids.iter().zip(scores.iter()) {
            require!(*score <= 1000, "score out of range");
            require!(self.agents.get(id).is_some(), "unknown agent");
            self.reputation.insert(*id, *score);
        }
        self.last_scored_epoch = epoch;
        emit(
            "epoch_scores",
            serde_json::json!({ "epoch": epoch, "agents": agent_ids, "scores": scores, "details_hash": details_hash }),
        );
    }

    pub fn reputation_of(&self, agent_id: AgentId) -> u16 {
        self.reputation.get(&agent_id).copied().unwrap_or(DEFAULT_REPUTATION)
    }

    pub fn reputations(&self, agent_ids: Vec<AgentId>) -> Vec<u16> {
        agent_ids.iter().map(|id| self.reputation_of(*id)).collect()
    }

    // ------------------------------------------------------------------ validation (disputes)

    /// The clearer records that a dispute about `agent`'s work went to `validator`.
    pub fn validation_request(&mut self, request_hash: String, validator: AgentId, agent: AgentId, uri: String) {
        self.only_clearer();
        let key = unhex32(&request_hash);
        require!(self.validations.get(&key).is_none(), "validation already requested");
        require!(self.agents.get(&validator).is_some() && self.agents.get(&agent).is_some(), "unknown agent");
        require!(validator != agent, "an agent cannot validate its own work");
        emit("validation_requested", serde_json::json!({ "request_hash": request_hash, "validator": validator, "agent": agent }));
        self.validations.insert(
            key,
            Validation { request_hash, validator, agent, uri, requested_at: env::block_timestamp_ms(), responded_at: 0, response: None },
        );
    }

    /// The validator answers from its own account. It must hold the minimum stake as collateral.
    pub fn validation_response(&mut self, request_hash: String, response: u8, uri: String) {
        require!(response <= 100, "response must be 0..100");
        let key = unhex32(&request_hash);
        let mut v = self.validations.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown validation request"));
        let caller = self.caller_agent();
        require!(caller.id == v.validator, "only the named validator may respond");
        require!(v.response.is_none(), "validation already answered");
        require!(self.collateral_of(caller.id).total.0 >= self.min_validator_stake, "validator stake is below the minimum");
        v.response = Some(response);
        v.responded_at = env::block_timestamp_ms();
        v.uri = uri;
        emit(
            "validation_answered",
            serde_json::json!({ "request_hash": v.request_hash, "validator": v.validator, "agent": v.agent, "response": response }),
        );
        self.validations.insert(key, v);
    }

    pub fn get_validation(&self, request_hash: String) -> Option<Validation> {
        self.validations.get(&unhex32(&request_hash)).cloned()
    }
}

// ---------------------------------------------------------------------- internals

impl Quorum {
    pub(crate) fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner may call this");
    }

    pub(crate) fn only_clearer(&self) {
        require!(env::predecessor_account_id() == self.clearer, "only the clearer may call this");
    }

    pub(crate) fn agent(&self, id: AgentId) -> Agent {
        self.agents.get(&id).cloned().unwrap_or_else(|| env::panic_str(&format!("unknown agent {id}")))
    }

    /// The active agent registered for the calling account.
    pub(crate) fn caller_agent(&self) -> Agent {
        let account = env::predecessor_account_id();
        let id = self.agent_by_account.get(&account).unwrap_or_else(|| env::panic_str("caller is not a registered agent"));
        let a = self.agent(*id);
        require!(a.status == AgentStatus::Active, "agent is not active");
        a
    }

    /// The agent, if the caller is the agent's own account or its operator.
    fn controlled_agent(&self, id: AgentId) -> Agent {
        let a = self.agent(id);
        let caller = env::predecessor_account_id();
        require!(caller == a.account || caller == a.operator, "only the agent or its operator may call this");
        a
    }

    pub(crate) fn collateral_of(&self, id: AgentId) -> Collateral {
        self.collateral.get(&id).cloned().unwrap_or_default()
    }
}

pub(crate) fn available(c: &Collateral) -> u128 {
    c.total.0.saturating_sub(c.locked.0).saturating_sub(c.pending_withdrawal.0)
}

fn check_window(ms: u64) {
    require!((5_000..=7 * 24 * 3_600_000).contains(&ms), "settlement window must be between 5 seconds and 7 days");
}
