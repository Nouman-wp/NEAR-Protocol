import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";
import { fromBase64, isAccountId, isPublicKey, nep413Hash, toBase64, verifyHash, type AccountId, type PublicKey, type Signature } from "./crypto.ts";

/**
 * Sign in with a NEAR wallet. The wallet signs a short NEP-413 message naming the account,
 * the network and the time; the server checks the signature, that the key is an access
 * key of the account on chain, and that the message is fresh and unused. It then issues a
 * session token: the account and an expiry, MACed with a secret only the backend holds.
 */

export const AUTH_RECIPIENT = "yuki-sign-in";
const utf8 = new TextEncoder();

export function loginMessage(accountId: AccountId, network: string, issuedAt: number): string {
  return `Sign in to Yuki\n\nAccount: ${accountId}\nNetwork: ${network}\nIssued: ${new Date(issuedAt).toISOString()}`;
}

export function parseLoginMessage(message: string): { accountId: string; network: string; issuedAt: number } | null {
  const m = message.match(/^Sign in to Yuki\n\nAccount: ([a-z0-9._-]+)\nNetwork: ([a-z]+)\nIssued: (\S+)$/);
  if (!m) return null;
  const issuedAt = Date.parse(m[3]!);
  return Number.isFinite(issuedAt) ? { accountId: m[1]!, network: m[2]!, issuedAt } : null;
}

/** A wallet's base64 signature as a Yuki signature string; a Yuki signature passes through. */
export function normaliseSignature(signature: string): Signature {
  if (signature.startsWith("ed25519:")) return signature;
  return `ed25519:${base58.encode(fromBase64(signature))}`;
}

export interface WalletSignature {
  message: string;
  recipient: string;
  /** 32 bytes, base64 */
  nonce: string;
  /** some wallets (MyNearWallet) include the callback URL in what they sign */
  callbackUrl?: string;
  publicKey: PublicKey;
  signature: string;
}

/** True if the wallet signed exactly this NEP-413 payload, with or without the callback URL. */
export function verifyWalletSignature(s: WalletSignature): boolean {
  if (!isPublicKey(s.publicKey)) return false;
  let nonce: Uint8Array;
  try {
    nonce = fromBase64(s.nonce);
  } catch {
    return false;
  }
  if (nonce.length !== 32) return false;
  const sig = normaliseSignature(s.signature);
  if (verifyHash(nep413Hash(s.message, s.recipient, nonce), sig, s.publicKey)) return true;
  return s.callbackUrl !== undefined && verifyHash(nep413Hash(s.message, s.recipient, nonce, s.callbackUrl), sig, s.publicKey);
}

// ------------------------------------------------------------------ sessions

export interface Session {
  accountId: AccountId;
  expiresAt: number;
}

export function sessionSecret(seed: string): Uint8Array {
  return sha256(utf8.encode(`quorum/session/${seed}`));
}

const mac = (secret: Uint8Array, body: string) => toBase64(hmac(sha256, secret, utf8.encode(body))).replace(/=+$/, "");

export function issueSession(secret: Uint8Array, accountId: AccountId, ttlMs = 7 * 86_400_000): { token: string; session: Session } {
  const session = { accountId, expiresAt: Date.now() + ttlMs };
  const body = toBase64(utf8.encode(JSON.stringify(session))).replace(/=+$/, "");
  return { token: `${body}.${mac(secret, body)}`, session };
}

/** The session a token stands for, or null if it is forged, malformed or expired. */
export function readSession(secret: Uint8Array, token: string | null | undefined): Session | null {
  if (!token) return null;
  const [body, tag] = token.replace(/^Bearer\s+/i, "").split(".");
  if (!body || !tag) return null;
  const want = mac(secret, body);
  if (want.length !== tag.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ tag.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
    const s = JSON.parse(new TextDecoder().decode(fromBase64(padded))) as Session;
    if (!isAccountId(s.accountId) || typeof s.expiresAt !== "number" || s.expiresAt < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}
