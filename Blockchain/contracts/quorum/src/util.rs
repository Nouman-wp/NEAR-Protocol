//! Hashing, encoding and event helpers shared by the contract modules.
use near_sdk::{env, PublicKey};

pub type Hash = [u8; 32];

pub const ZERO_HEX: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NEP413_TAG: u32 = 2_147_484_061; // 2^31 + 413

pub fn hex32(h: &Hash) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    for b in h {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// Parse a lower-case `0x` + 64 hex string. Upper-case is refused so that a hash has
/// exactly one text form, which matters because hashes are embedded in signed messages.
pub fn unhex32(s: &str) -> Hash {
    let b = s.as_bytes();
    if b.len() != 66 || b[0] != b'0' || b[1] != b'x' {
        env::panic_str("expected a 0x-prefixed 32-byte hex string");
    }
    let nibble = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => env::panic_str("expected lower-case hex"),
        }
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (nibble(b[2 + 2 * i]) << 4) | nibble(b[3 + 2 * i]);
    }
    out
}

/// The hash a NEP-413 signer signs: sha256(tag ++ borsh(payload)).
/// Quorum messages use a deterministic nonce, sha256(message), so the signed bytes
/// follow from the message and the recipient alone.
pub fn nep413_hash(message: &str, recipient: &str) -> Hash {
    let nonce = env::sha256_array(message.as_bytes());
    let mut buf = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    buf.extend_from_slice(&NEP413_TAG.to_le_bytes());
    buf.extend_from_slice(&(message.len() as u32).to_le_bytes());
    buf.extend_from_slice(message.as_bytes());
    buf.extend_from_slice(&nonce);
    buf.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    buf.extend_from_slice(recipient.as_bytes());
    buf.push(0); // callbackUrl: None
    env::sha256_array(&buf)
}

pub fn decode_signature(s: &str) -> [u8; 64] {
    let body = s.strip_prefix("ed25519:").unwrap_or_else(|| env::panic_str("signature must start with ed25519:"));
    let bytes = bs58::decode(body).into_vec().unwrap_or_else(|_| env::panic_str("signature is not base58"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"))
}

pub fn ed25519_bytes(pk: &PublicKey) -> [u8; 32] {
    let b = pk.as_bytes();
    if b.len() != 33 || b[0] != 0 {
        env::panic_str("only ed25519 keys are supported");
    }
    b[1..].try_into().unwrap()
}

/// sha256 over the concatenation of `parts`.
pub fn hash_parts(parts: &[&[u8]]) -> Hash {
    let mut buf = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    for p in parts {
        buf.extend_from_slice(p);
    }
    env::sha256_array(&buf)
}

/// NEP-297 event log.
pub fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({ "standard": "quorum", "version": "1.0.0", "event": event, "data": [data] })
    ));
}
