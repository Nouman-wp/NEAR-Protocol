//! Test USDC: a minimal NEP-141 token with six decimals and an open, capped faucet.
//! For local sandboxes and testnet only. Accounts are registered automatically, so
//! `storage_deposit` is accepted but never required.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PromiseResult,
};

const FAUCET_CAP: u128 = 10_000_000_000; // 10,000 tUSDC per call
const GAS_RESOLVE: Gas = Gas::from_tgas(10);
const GAS_RESERVE: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Balances,
}

#[near(serializers = [json])]
pub struct Metadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestUsdc {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
}

#[near]
impl TestUsdc {
    #[init]
    pub fn new() -> Self {
        Self { balances: LookupMap::new(Key::Balances), total_supply: 0 }
    }

    /// Open faucet, capped per call. `account_id` defaults to the caller.
    pub fn mint(&mut self, account_id: Option<AccountId>, amount: U128) {
        require!(amount.0 > 0 && amount.0 <= FAUCET_CAP, "faucet: amount out of range");
        let to = account_id.unwrap_or_else(env::predecessor_account_id);
        self.credit(&to, amount.0);
        self.total_supply += amount.0;
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{{"owner_id":"{}","amount":"{}"}}]}}"#,
            to, amount.0
        ));
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0, memo.as_deref());
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0, memo.as_deref());
        let args = serde_json::json!({ "sender_id": sender, "amount": amount, "msg": msg }).to_string().into_bytes();
        let forward = env::prepaid_gas()
            .saturating_sub(env::used_gas())
            .saturating_sub(GAS_RESOLVE)
            .saturating_sub(GAS_RESERVE);
        Promise::new(receiver_id.clone())
            .function_call("ft_on_transfer".to_string(), args, NearToken::from_yoctonear(0), forward)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    /// The receiver returns how much it did not use. A failed call refunds everything.
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => {
                serde_json::from_slice::<U128>(&bytes).map(|u| u.0.min(amount.0)).unwrap_or(amount.0)
            }
            _ => amount.0,
        };
        if unused == 0 {
            return amount;
        }
        let held = self.balance(&receiver_id);
        let refund = unused.min(held);
        if refund > 0 {
            self.balances.insert(receiver_id.clone(), held - refund);
            self.credit(&sender_id, refund);
            emit_transfer(&receiver_id, &sender_id, refund, Some("refund"));
        }
        U128(amount.0 - refund)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_metadata(&self) -> Metadata {
        Metadata {
            spec: "ft-1.0.0".into(),
            name: "Quorum Test USDC".into(),
            symbol: "tUSDC".into(),
            decimals: 6,
            icon: None,
            reference: None,
            reference_hash: None,
        }
    }

    /// Accepted for wallet and tooling compatibility. Any deposit is refunded.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = (account_id, registration_only);
        let attached = env::attached_deposit();
        if attached.as_yoctonear() > 0 {
            Promise::new(env::predecessor_account_id()).transfer(attached).detach();
        }
        StorageBalance { total: U128(0), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let _ = account_id;
        Some(StorageBalance { total: U128(0), available: U128(0) })
    }
}

impl TestUsdc {
    fn balance(&self, id: &AccountId) -> u128 {
        self.balances.get(id).copied().unwrap_or(0)
    }

    fn credit(&mut self, id: &AccountId, amount: u128) {
        let b = self.balance(id);
        self.balances.insert(id.clone(), b + amount);
    }

    fn transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver are the same");
        let b = self.balance(from);
        require!(b >= amount, "not enough balance");
        self.balances.insert(from.clone(), b - amount);
        self.credit(to, amount);
        emit_transfer(from, to, amount, memo);
    }
}

fn require_one_yocto() {
    require!(env::attached_deposit().as_yoctonear() == 1, "requires exactly 1 yoctoNEAR");
}

fn emit_transfer(from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
    let memo = memo.map(|m| format!(r#","memo":{}"#, serde_json::to_string(m).unwrap())).unwrap_or_default();
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{{"old_owner_id":"{}","new_owner_id":"{}","amount":"{}"{}}}]}}"#,
        from, to, amount, memo
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(who: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    #[test]
    fn mint_and_transfer() {
        ctx("alice.near", 0);
        let mut t = TestUsdc::new();
        t.mint(None, U128(5_000_000));
        ctx("alice.near", 1);
        t.ft_transfer("bob.near".parse().unwrap(), U128(2_000_000), None);
        assert_eq!(t.ft_balance_of("alice.near".parse().unwrap()).0, 3_000_000);
        assert_eq!(t.ft_balance_of("bob.near".parse().unwrap()).0, 2_000_000);
        assert_eq!(t.ft_total_supply().0, 5_000_000);
    }

    #[test]
    #[should_panic(expected = "not enough balance")]
    fn cannot_overspend() {
        ctx("alice.near", 1);
        let mut t = TestUsdc::new();
        t.ft_transfer("bob.near".parse().unwrap(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "faucet: amount out of range")]
    fn faucet_is_capped() {
        ctx("alice.near", 0);
        let mut t = TestUsdc::new();
        t.mint(None, U128(FAUCET_CAP + 1));
    }
}
