//! intents-lite: a small stand-in for the NEAR Intents verifier (`intents.near`).
//!
//! `intents.near` exists on mainnet only, so local sandboxes and testnet need something
//! that speaks the same wire format. This contract implements the subset Quorum uses, with
//! the same method names, argument shapes and signing rules as the real verifier:
//!
//!   * deposits: `ft_transfer_call` to this contract, `msg` = the account to credit
//!   * `add_public_key` / `remove_public_key` / `has_public_key`
//!   * `execute_intents(signed)` with NEP-413 payloads carrying `transfer` and
//!     `ft_withdraw` intents, executed atomically: one bad intent reverts the batch
//!   * `mt_balance_of`, `mt_batch_balance_of`, `mt_transfer` with `nep141:<token>` ids
//!
//! It is not a replacement for the verifier: no `token_diff`, no fees, no other signing
//! standards. Point Quorum at `intents.near` on mainnet and this contract is not used.
use base64::Engine;
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey};
use std::collections::BTreeMap;

const NEP413_TAG: u32 = 2_147_484_061; // 2^31 + 413
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Balances,
    Keys,
    Nonces,
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

#[near(serializers = [json])]
#[derive(Clone)]
pub struct SignedPayload {
    pub standard: String,
    pub payload: Nep413Payload,
    pub public_key: String,
    pub signature: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct IntentsLite {
    /// (account, token id such as "nep141:usdc.near") -> balance
    balances: LookupMap<(AccountId, String), u128>,
    /// (account, "ed25519:<base58>") keys allowed to sign intents for the account
    keys: LookupSet<(AccountId, String)>,
    /// (account, nonce) pairs already used
    nonces: LookupSet<(AccountId, [u8; 32])>,
}

#[near]
impl IntentsLite {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(Key::Balances),
            keys: LookupSet::new(Key::Keys),
            nonces: LookupSet::new(Key::Nonces),
        }
    }

    // ------------------------------------------------------------------ deposits

    /// NEP-141 deposit. `msg` is empty (credit the sender), an account id, or a JSON
    /// object with `receiver_id`, as on `intents.near`.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let receiver: AccountId = if msg.is_empty() {
            sender_id
        } else if msg.trim_start().starts_with('{') {
            let v: serde_json::Value = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad deposit message"));
            v.get("receiver_id")
                .and_then(|r| r.as_str())
                .and_then(|r| r.parse().ok())
                .unwrap_or_else(|| env::panic_str("deposit message needs receiver_id"))
        } else {
            msg.parse().unwrap_or_else(|_| env::panic_str("bad receiver account"))
        };
        let token_id = format!("nep141:{token}");
        self.credit(&receiver, &token_id, amount.0);
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{{"owner_id":"{receiver}","token_ids":["{token_id}"],"amounts":["{}"]}}]}}"#,
            amount.0
        ));
        U128(0)
    }

    // ------------------------------------------------------------------ keys

    /// Allow `public_key` to sign intents for the calling account.
    #[payable]
    pub fn add_public_key(&mut self, public_key: PublicKey) {
        let account = env::predecessor_account_id();
        self.keys.insert((account, String::from(&public_key)));
    }

    #[payable]
    pub fn remove_public_key(&mut self, public_key: PublicKey) {
        let account = env::predecessor_account_id();
        self.keys.remove(&(account, String::from(&public_key)));
    }

    pub fn has_public_key(&self, account_id: AccountId, public_key: PublicKey) -> bool {
        self.key_allowed(&account_id, &String::from(&public_key))
    }

    // ------------------------------------------------------------------ intents

    /// Verify and execute signed intents in order. Any failure panics, which reverts
    /// every balance change in the batch.
    pub fn execute_intents(&mut self, signed: Vec<SignedPayload>) {
        require!(!signed.is_empty(), "no intents");
        let me = env::current_account_id();
        for s in signed {
            require!(s.standard == "nep413", "only the nep413 standard is supported");
            require!(s.payload.recipient == me.as_str(), "payload is for a different verifier");

            let nonce = decode_nonce(&s.payload.nonce);
            let hash = nep413_hash(&s.payload.message, &nonce, &s.payload.recipient, s.payload.callback_url.as_deref());
            let pk: PublicKey = s.public_key.parse().unwrap_or_else(|_| env::panic_str("bad public key"));
            let pk_bytes = pk.as_bytes();
            require!(pk_bytes.len() == 33 && pk_bytes[0] == 0, "only ed25519 keys are supported");
            let key: [u8; 32] = pk_bytes[1..].try_into().unwrap();
            let sig = decode_signature(&s.signature);
            require!(env::ed25519_verify(&sig, &hash, &key), "invalid signature");

            let msg: serde_json::Value =
                serde_json::from_str(&s.payload.message).unwrap_or_else(|_| env::panic_str("message is not JSON"));
            let signer: AccountId = msg
                .get("signer_id")
                .and_then(|v| v.as_str())
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| env::panic_str("message needs signer_id"));
            require!(self.key_allowed(&signer, &String::from(&pk)), "public key is not registered for signer_id");

            let deadline = msg.get("deadline").and_then(|v| v.as_str()).unwrap_or_else(|| env::panic_str("message needs deadline"));
            require!(parse_iso8601_ms(deadline) > env::block_timestamp_ms(), "deadline has passed");
            require!(self.nonces.insert((signer.clone(), nonce)), "nonce already used");

            let intents = msg.get("intents").and_then(|v| v.as_array()).unwrap_or_else(|| env::panic_str("message needs intents"));
            for intent in intents {
                self.apply(&signer, intent);
            }
        }
    }

    // ------------------------------------------------------------------ balances (NEP-245 subset)

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&account_id, &token_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balance(&account_id, t))).collect()
    }

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<serde_json::Value>,
        memo: Option<String>,
    ) {
        let _ = approval;
        require!(env::attached_deposit().as_yoctonear() == 1, "requires exactly 1 yoctoNEAR");
        let sender = env::predecessor_account_id();
        self.move_tokens(&sender, &receiver_id, &token_id, amount.0, memo.as_deref());
    }
}

impl IntentsLite {
    fn balance(&self, account: &AccountId, token_id: &str) -> u128 {
        self.balances.get(&(account.clone(), token_id.to_string())).copied().unwrap_or(0)
    }

    fn credit(&mut self, account: &AccountId, token_id: &str, amount: u128) {
        let b = self.balance(account, token_id);
        self.balances.insert((account.clone(), token_id.to_string()), b + amount);
    }

    fn debit(&mut self, account: &AccountId, token_id: &str, amount: u128) {
        let b = self.balance(account, token_id);
        if b < amount {
            env::panic_str(&format!("insufficient balance: {account} has {b} of {token_id}, needs {amount}"));
        }
        self.balances.insert((account.clone(), token_id.to_string()), b - amount);
    }

    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, token_id: &str, amount: u128, memo: Option<&str>) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver are the same");
        self.debit(from, token_id, amount);
        self.credit(to, token_id, amount);
        let memo = memo.map(|m| format!(r#","memo":{}"#, serde_json::to_string(m).unwrap())).unwrap_or_default();
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{{"old_owner_id":"{from}","new_owner_id":"{to}","token_ids":["{token_id}"],"amounts":["{amount}"]{memo}}}]}}"#
        ));
    }

    /// A key may sign for an account if the account registered it, or if the account is
    /// the implicit account of that key (64 hex characters of the public key).
    fn key_allowed(&self, account: &AccountId, public_key: &str) -> bool {
        if self.keys.contains(&(account.clone(), public_key.to_string())) {
            return true;
        }
        if let Ok(pk) = public_key.parse::<PublicKey>() {
            let bytes = pk.as_bytes();
            if bytes.len() == 33 && bytes[0] == 0 {
                let implicit: String = bytes[1..].iter().map(|b| format!("{b:02x}")).collect();
                return implicit == account.as_str();
            }
        }
        false
    }

    fn apply(&mut self, signer: &AccountId, intent: &serde_json::Value) {
        let kind = intent.get("intent").and_then(|v| v.as_str()).unwrap_or_else(|| env::panic_str("intent needs a type"));
        match kind {
            "transfer" => {
                let receiver: AccountId = intent
                    .get("receiver_id")
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| env::panic_str("transfer needs receiver_id"));
                let memo = intent.get("memo").and_then(|v| v.as_str());
                let tokens: BTreeMap<String, String> = intent
                    .get("tokens")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_else(|| env::panic_str("transfer needs tokens"));
                require!(!tokens.is_empty(), "transfer needs at least one token");
                for (token_id, amount) in tokens {
                    let amount: u128 = amount.parse().unwrap_or_else(|_| env::panic_str("bad amount"));
                    self.move_tokens(signer, &receiver, &token_id, amount, memo);
                }
            }
            "ft_withdraw" => {
                let token: AccountId = intent
                    .get("token")
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| env::panic_str("ft_withdraw needs token"));
                let receiver: AccountId = intent
                    .get("receiver_id")
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| env::panic_str("ft_withdraw needs receiver_id"));
                let amount: u128 = intent
                    .get("amount")
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| env::panic_str("ft_withdraw needs amount"));
                require!(amount > 0, "amount must be positive");
                self.debit(signer, &format!("nep141:{token}"), amount);
                let args = serde_json::json!({ "receiver_id": receiver, "amount": U128(amount) }).to_string().into_bytes();
                Promise::new(token)
                    .function_call("ft_transfer".to_string(), args, NearToken::from_yoctonear(1), GAS_FT_TRANSFER)
                    .detach();
            }
            other => env::panic_str(&format!("intent type '{other}' is not supported by intents-lite")),
        }
    }
}

/// sha256 over the NEP-413 tag followed by the borsh-encoded payload.
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str, callback_url: Option<&str>) -> [u8; 32] {
    let mut buf = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    buf.extend_from_slice(&NEP413_TAG.to_le_bytes());
    buf.extend_from_slice(&(message.len() as u32).to_le_bytes());
    buf.extend_from_slice(message.as_bytes());
    buf.extend_from_slice(nonce);
    buf.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    buf.extend_from_slice(recipient.as_bytes());
    match callback_url {
        None => buf.push(0),
        Some(url) => {
            buf.push(1);
            buf.extend_from_slice(&(url.len() as u32).to_le_bytes());
            buf.extend_from_slice(url.as_bytes());
        }
    }
    env::sha256_array(&buf)
}

fn decode_nonce(b64: &str) -> [u8; 32] {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap_or_else(|_| env::panic_str("nonce is not base64"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("nonce must be 32 bytes"))
}

fn decode_signature(s: &str) -> [u8; 64] {
    let body = s.strip_prefix("ed25519:").unwrap_or_else(|| env::panic_str("signature must start with ed25519:"));
    let bytes = bs58::decode(body).into_vec().unwrap_or_else(|_| env::panic_str("signature is not base58"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"))
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.fraction]Z` into unix milliseconds.
pub fn parse_iso8601_ms(s: &str) -> u64 {
    let bad = || -> ! { env::panic_str("deadline must be an ISO 8601 UTC timestamp") };
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[b.len() - 1] != b'Z' {
        bad();
    }
    let num = |from: usize, to: usize| -> u64 { s.get(from..to).and_then(|p| p.parse::<u64>().ok()).unwrap_or_else(|| bad()) };
    let (year, month, day) = (num(0, 4), num(5, 7), num(8, 10));
    let (hour, minute, second) = (num(11, 13), num(14, 16), num(17, 19));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 || year < 1970 {
        bad();
    }
    let mut millis = 0u64;
    if b[19] == b'.' {
        let frac = &s[20..s.len() - 1];
        if frac.is_empty() || !frac.bytes().all(|c| c.is_ascii_digit()) {
            bad();
        }
        let mut digits = frac.chars().take(3).collect::<String>();
        while digits.len() < 3 {
            digits.push('0');
        }
        millis = digits.parse().unwrap_or_else(|_| bad());
    } else if b.len() != 20 {
        bad();
    }
    // days from civil (Howard Hinnant's algorithm)
    let y = if month <= 2 { year - 1 } else { year };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const VERIFIER: &str = "intents.test.near";
    const USDC: &str = "usdc.test.near";
    const TOKEN_ID: &str = "nep141:usdc.test.near";

    fn ctx(who: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(VERIFIER.parse().unwrap())
            .predecessor_account_id(who.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(1_800_000_000_000_000_000)
            .build());
    }

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn pk_string(k: &SigningKey) -> String {
        format!("ed25519:{}", bs58::encode(k.verifying_key().to_bytes()).into_string())
    }

    fn sign(k: &SigningKey, signer: &str, nonce: [u8; 32], deadline: &str, intents: serde_json::Value) -> SignedPayload {
        let message = serde_json::json!({ "signer_id": signer, "deadline": deadline, "intents": intents }).to_string();
        let hash = nep413_hash(&message, &nonce, VERIFIER, None);
        let sig = k.sign(&hash);
        SignedPayload {
            standard: "nep413".into(),
            payload: Nep413Payload {
                message,
                nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
                recipient: VERIFIER.into(),
                callback_url: None,
            },
            public_key: pk_string(k),
            signature: format!("ed25519:{}", bs58::encode(sig.to_bytes()).into_string()),
        }
    }

    fn transfer(to: &str, amount: u128) -> serde_json::Value {
        serde_json::json!([{ "intent": "transfer", "receiver_id": to, "tokens": { TOKEN_ID: amount.to_string() } }])
    }

    fn setup() -> (IntentsLite, SigningKey) {
        ctx(USDC, 0);
        let mut v = IntentsLite::new();
        v.ft_on_transfer("alice.test.near".parse().unwrap(), U128(1_000), String::new());
        let k = key(7);
        ctx("alice.test.near", 1);
        v.add_public_key(pk_string(&k).parse().unwrap());
        (v, k)
    }

    const LATER: &str = "2030-01-01T00:00:00.000Z";

    #[test]
    fn deposit_credits_the_named_account() {
        ctx(USDC, 0);
        let mut v = IntentsLite::new();
        v.ft_on_transfer("alice.test.near".parse().unwrap(), U128(500), "bob.test.near".into());
        v.ft_on_transfer("alice.test.near".parse().unwrap(), U128(7), r#"{"receiver_id":"carol.test.near"}"#.into());
        assert_eq!(v.mt_balance_of("bob.test.near".parse().unwrap(), TOKEN_ID.into()).0, 500);
        assert_eq!(v.mt_balance_of("carol.test.near".parse().unwrap(), TOKEN_ID.into()).0, 7);
        assert_eq!(v.mt_balance_of("alice.test.near".parse().unwrap(), TOKEN_ID.into()).0, 0);
    }

    #[test]
    fn signed_transfer_moves_balance() {
        let (mut v, k) = setup();
        ctx("relayer.test.near", 0);
        v.execute_intents(vec![sign(&k, "alice.test.near", [1; 32], LATER, transfer("bob.test.near", 400))]);
        assert_eq!(v.mt_balance_of("alice.test.near".parse().unwrap(), TOKEN_ID.into()).0, 600);
        assert_eq!(v.mt_balance_of("bob.test.near".parse().unwrap(), TOKEN_ID.into()).0, 400);
    }

    #[test]
    #[should_panic(expected = "nonce already used")]
    fn nonce_cannot_be_replayed() {
        let (mut v, k) = setup();
        let s = sign(&k, "alice.test.near", [2; 32], LATER, transfer("bob.test.near", 100));
        v.execute_intents(vec![s.clone()]);
        v.execute_intents(vec![s]);
    }

    #[test]
    #[should_panic(expected = "public key is not registered")]
    fn unregistered_key_is_rejected() {
        let (mut v, _) = setup();
        let stranger = key(9);
        v.execute_intents(vec![sign(&stranger, "alice.test.near", [3; 32], LATER, transfer("bob.test.near", 1))]);
    }

    #[test]
    #[should_panic(expected = "invalid signature")]
    fn altered_message_is_rejected() {
        let (mut v, k) = setup();
        let mut s = sign(&k, "alice.test.near", [4; 32], LATER, transfer("bob.test.near", 1));
        s.payload.message = s.payload.message.replace("\"1\"", "\"999\"");
        v.execute_intents(vec![s]);
    }

    #[test]
    #[should_panic(expected = "deadline has passed")]
    fn expired_intent_is_rejected() {
        let (mut v, k) = setup();
        v.execute_intents(vec![sign(&k, "alice.test.near", [5; 32], "2020-01-01T00:00:00Z", transfer("bob.test.near", 1))]);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn overdraft_reverts_the_batch() {
        let (mut v, k) = setup();
        v.execute_intents(vec![
            sign(&k, "alice.test.near", [6; 32], LATER, transfer("bob.test.near", 900)),
            sign(&k, "alice.test.near", [7; 32], LATER, transfer("bob.test.near", 200)),
        ]);
    }

    #[test]
    fn implicit_account_signs_without_registration() {
        let k = key(11);
        let implicit: String = k.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        ctx(USDC, 0);
        let mut v = IntentsLite::new();
        v.ft_on_transfer("alice.test.near".parse().unwrap(), U128(50), implicit.clone());
        v.execute_intents(vec![sign(&k, &implicit, [8; 32], LATER, transfer("bob.test.near", 50))]);
        assert_eq!(v.mt_balance_of("bob.test.near".parse().unwrap(), TOKEN_ID.into()).0, 50);
    }

    #[test]
    fn iso8601_parses_to_unix_ms() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), 0);
        assert_eq!(parse_iso8601_ms("2000-03-01T00:00:00.000Z"), 951_868_800_000);
        assert_eq!(parse_iso8601_ms("2026-11-14T23:59:00.250Z"), 1_794_700_740_250);
        assert_eq!(parse_iso8601_ms("2025-05-21T10:34:04.254392Z"), 1_747_823_644_254);
    }
}
