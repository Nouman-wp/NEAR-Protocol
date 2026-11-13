import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519";
import { AUTH_RECIPIENT, issueSession, loginMessage, nep413Hash, normaliseSignature, parseLoginMessage, randomBytes, randomKeyPair, readSession, sessionSecret, toBase64, verifyWalletSignature } from "../src/index.ts";

/** What a wallet does: sign the NEP-413 payload and return a base64 signature. */
function walletSign(secretKey: string, message: string, recipient: string, nonce: Uint8Array, callbackUrl?: string): string {
  const seed = base58.decode(secretKey.slice(8)).slice(0, 32);
  return toBase64(ed25519.sign(nep413Hash(message, recipient, nonce, callbackUrl), seed));
}

describe("sign in with a NEAR wallet", () => {
  const key = randomKeyPair();
  const message = loginMessage("alice.testnet", "testnet", Date.now());
  const nonce = randomBytes(32);

  it("round-trips the login message", () => {
    const p = parseLoginMessage(message)!;
    expect(p.accountId).toBe("alice.testnet");
    expect(p.network).toBe("testnet");
    expect(Math.abs(p.issuedAt - Date.now())).toBeLessThan(2000);
    expect(parseLoginMessage("Sign in to something else")).toBeNull();
  });

  it("accepts a wallet signature with or without the callback URL in the payload", () => {
    const base = { message, recipient: AUTH_RECIPIENT, nonce: toBase64(nonce), publicKey: key.publicKey };
    expect(verifyWalletSignature({ ...base, signature: walletSign(key.secretKey, message, AUTH_RECIPIENT, nonce) })).toBe(true);
    const cb = "https://quorum.example/dashboard";
    expect(verifyWalletSignature({ ...base, callbackUrl: cb, signature: walletSign(key.secretKey, message, AUTH_RECIPIENT, nonce, cb) })).toBe(true);
  });

  it("refuses a signature by another key, over another message, or for another recipient", () => {
    const other = randomKeyPair();
    const base = { message, recipient: AUTH_RECIPIENT, nonce: toBase64(nonce), publicKey: key.publicKey };
    expect(verifyWalletSignature({ ...base, signature: walletSign(other.secretKey, message, AUTH_RECIPIENT, nonce) })).toBe(false);
    expect(verifyWalletSignature({ ...base, signature: walletSign(key.secretKey, `${message}!`, AUTH_RECIPIENT, nonce) })).toBe(false);
    expect(verifyWalletSignature({ ...base, signature: walletSign(key.secretKey, message, "evil.near", nonce) })).toBe(false);
  });

  it("normalises a base64 wallet signature to a Quorum signature", () => {
    const sig = walletSign(key.secretKey, message, AUTH_RECIPIENT, nonce);
    expect(normaliseSignature(sig).startsWith("ed25519:")).toBe(true);
    expect(normaliseSignature(normaliseSignature(sig))).toBe(normaliseSignature(sig));
  });
});

describe("sessions", () => {
  const secret = sessionSecret("test-seed");

  it("issues tokens that read back, and refuses forged, foreign or expired ones", () => {
    const { token } = issueSession(secret, "alice.testnet");
    expect(readSession(secret, token)?.accountId).toBe("alice.testnet");
    expect(readSession(secret, `Bearer ${token}`)?.accountId).toBe("alice.testnet");
    expect(readSession(sessionSecret("other-seed"), token)).toBeNull();
    const [body, tag] = token.split(".");
    const forged = toBase64(new TextEncoder().encode(JSON.stringify({ accountId: "bob.testnet", expiresAt: Date.now() + 1e9 }))).replace(/=+$/, "");
    expect(readSession(secret, `${forged}.${tag}`)).toBeNull();
    expect(readSession(secret, `${body}.x${tag!.slice(1)}`)).toBeNull();
    expect(readSession(secret, issueSession(secret, "alice.testnet", -1).token)).toBeNull();
  });
});

describe("which network an account signs in from", () => {
  it("reads named accounts and lets a testnet deployment accept mainnet accounts", async () => {
    const { accountNetwork, signInNetworks } = await import("../src/index.ts");
    expect(accountNetwork("alice.testnet", "testnet")).toBe("testnet");
    expect(accountNetwork("alice.near", "testnet")).toBe("mainnet");
    expect(accountNetwork("a".repeat(64), "testnet")).toBe("testnet");
    expect(signInNetworks("testnet")).toEqual(["mainnet", "testnet"]);
    expect(signInNetworks("mainnet")).toEqual(["mainnet"]);
    expect(signInNetworks("local")).toEqual(["local"]);
  });
});
