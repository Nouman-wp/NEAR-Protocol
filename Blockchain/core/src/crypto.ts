import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base58, base64 } from "@scure/base";

/**
 * Hashing and signing primitives. Everything is sha256 and ed25519, the two things a NEAR
 * contract can check cheaply, and every signature is a NEP-413 signature, the format NEAR
 * wallets produce and the NEAR Intents verifier accepts.
 */

export type Hex = `0x${string}`;
/** A NEAR account id, e.g. `scout.yuki.testnet`. */
export type AccountId = string;
/** `ed25519:<base58 of 32 bytes>` */
export type PublicKey = string;
/** `ed25519:<base58 of 64 bytes>` */
export type Signature = string;

export const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;
const NEP413_TAG = 2_147_484_061; // 2^31 + 413
const utf8 = new TextEncoder();

// ------------------------------------------------------------------ bytes

export function bytesToHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("not a hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function isHash(v: unknown): v is Hex {
  return typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function u128le(n: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const view = new DataView(b.buffer);
  view.setBigUint64(0, n & 0xffff_ffff_ffff_ffffn, true);
  view.setBigUint64(8, n >> 64n, true);
  return b;
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === "string" ? utf8.encode(data) : data);
}

export function sha256Hex(data: Uint8Array | string): Hex {
  return bytesToHex(sha256Bytes(data));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function fromBase64(s: string): Uint8Array {
  return base64.decode(s);
}

// ------------------------------------------------------------------ canonical JSON

/** Deterministic JSON: object keys sorted, bigints as decimal strings, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  return v;
}

export function hashJson(value: unknown): Hex {
  return sha256Hex(canonicalJson(value));
}

export interface JobSpec {
  buyer: string; // agent id as decimal string
  seller: string;
  service: string;
  input: unknown;
  requestedAt: number; // unix ms
  salt: string;
  /** the sealed-bid round that set this job's price, if any */
  round?: string;
}

export function jobHash(spec: JobSpec): Hex {
  return hashJson(spec);
}

// ------------------------------------------------------------------ keys

export interface KeyPair {
  /** `ed25519:<base58 of seed ++ public key>`, the format NEAR tooling uses */
  secretKey: string;
  publicKey: PublicKey;
}

export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error("an ed25519 seed is 32 bytes");
  const pub = ed25519.getPublicKey(seed);
  return { secretKey: `ed25519:${base58.encode(concatBytes(seed, pub))}`, publicKey: `ed25519:${base58.encode(pub)}` };
}

export function keyPairFromSecret(secretKey: string): KeyPair {
  return keyPairFromSeed(seedOf(secretKey));
}

export function randomKeyPair(): KeyPair {
  return keyPairFromSeed(randomBytes(32));
}

/** A key that follows from a master seed and a path, e.g. `quorum/agent/scout`. */
export function deriveKeyPair(masterSeed: string, path: string): KeyPair {
  return keyPairFromSeed(sha256Bytes(`${masterSeed}/${path}`));
}

function seedOf(secretKey: string): Uint8Array {
  const body = secretKey.startsWith("ed25519:") ? secretKey.slice(8) : secretKey;
  const bytes = base58.decode(body);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("an ed25519 secret key is 32 or 64 bytes");
  return bytes.slice(0, 32);
}

export function publicKeyBytes(publicKey: PublicKey): Uint8Array {
  if (!publicKey.startsWith("ed25519:")) throw new Error("only ed25519 keys are supported");
  const bytes = base58.decode(publicKey.slice(8));
  if (bytes.length !== 32) throw new Error("an ed25519 public key is 32 bytes");
  return bytes;
}

export function isPublicKey(v: unknown): v is PublicKey {
  try {
    return typeof v === "string" && publicKeyBytes(v).length === 32;
  } catch {
    return false;
  }
}

/** The implicit NEAR account of a key: its 32 bytes as 64 hex characters. */
export function implicitAccountId(publicKey: PublicKey): AccountId {
  return bytesToHex(publicKeyBytes(publicKey)).slice(2);
}

export function isAccountId(v: unknown): v is AccountId {
  return typeof v === "string" && v.length >= 2 && v.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v);
}

// ------------------------------------------------------------------ NEP-413

/**
 * The 32 bytes a NEP-413 signer signs: sha256(tag ++ borsh(payload)). Yuki's own
 * messages use sha256(message) as the nonce, so the signed bytes follow from the message
 * and the recipient alone, and a contract can rebuild them without being handed a nonce.
 */
export function nep413Hash(message: string, recipient: string, nonce?: Uint8Array, callbackUrl?: string): Uint8Array {
  const msg = utf8.encode(message);
  const rcp = utf8.encode(recipient);
  const n = nonce ?? sha256(msg);
  if (n.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  const cb = callbackUrl === undefined ? new Uint8Array([0]) : concatBytes(new Uint8Array([1]), u32le(utf8.encode(callbackUrl).length), utf8.encode(callbackUrl));
  return sha256(concatBytes(u32le(NEP413_TAG), u32le(msg.length), msg, n, u32le(rcp.length), rcp, cb));
}

export function signHash(hash: Uint8Array | Hex, secretKey: string): Signature {
  const bytes = typeof hash === "string" ? hexToBytes(hash) : hash;
  return `ed25519:${base58.encode(ed25519.sign(bytes, seedOf(secretKey)))}`;
}

/** Never throws: a malformed key or signature is simply not valid. */
export function verifyHash(hash: Uint8Array | Hex, signature: Signature, publicKey: PublicKey): boolean {
  try {
    if (!signature.startsWith("ed25519:")) return false;
    const sig = base58.decode(signature.slice(8));
    if (sig.length !== 64) return false;
    const bytes = typeof hash === "string" ? hexToBytes(hash) : hash;
    return ed25519.verify(sig, bytes, publicKeyBytes(publicKey));
  } catch {
    return false;
  }
}

export function toBase58(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

export function fromBase58(s: string): Uint8Array {
  return base58.decode(s);
}
