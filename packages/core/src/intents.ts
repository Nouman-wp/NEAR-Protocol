import {
  bytesToHex,
  fromBase64,
  nep413Hash,
  sha256Bytes,
  signHash,
  toBase64,
  verifyHash,
  type AccountId,
  type Hex,
  type PublicKey,
  type Signature,
} from "./crypto.ts";

/**
 * NEAR Intents wire objects. A net debt is settled by the debtor signing one NEP-413
 * payload of `transfer` intents, addressed to the verifier (`intents.near` on mainnet).
 * The coordinator contract checks the payload against its settlement plan and forwards
 * the whole epoch's batch to the verifier's `execute_intents`.
 */

/** Which verifier a deployment settles through. */
export type VerifierKind = "near-intents" | "intents-lite";

export interface TransferIntent {
  intent: "transfer";
  receiver_id: AccountId;
  /** token id (`nep141:<account>`) -> amount in base units */
  tokens: Record<string, string>;
  memo?: string;
}

export interface IntentMessage {
  signer_id: AccountId;
  /** ISO 8601 UTC */
  deadline: string;
  intents: TransferIntent[];
}

/** A signed payload exactly as `execute_intents` takes it. */
export interface SignedIntent {
  standard: "nep413";
  payload: { message: string; nonce: string; recipient: AccountId };
  public_key: PublicKey;
  signature: Signature;
}

export function intentsTokenId(token: AccountId): string {
  return `nep141:${token}`;
}

/**
 * The nonce of the payload that settles one agent's debt in one epoch. The verifier
 * refuses a nonce it has seen, so the same debt can never be paid twice, whoever submits.
 */
export function settlementNonce(contract: AccountId, epoch: number | bigint, agentId: number | bigint | string): Uint8Array {
  return sha256Bytes(`quorum.settlement.v1:${contract}:${epoch}:${agentId}`);
}

export function signIntents(args: {
  signerId: AccountId;
  verifier: AccountId;
  intents: TransferIntent[];
  /** unix ms after which the verifier refuses the payload */
  deadline: number;
  nonce: Uint8Array;
  secretKey: string;
  publicKey: PublicKey;
}): SignedIntent {
  const message = JSON.stringify({ signer_id: args.signerId, deadline: new Date(args.deadline).toISOString(), intents: args.intents } satisfies IntentMessage);
  return {
    standard: "nep413",
    payload: { message, nonce: toBase64(args.nonce), recipient: args.verifier },
    public_key: args.publicKey,
    signature: signHash(nep413Hash(message, args.verifier, args.nonce), args.secretKey),
  };
}

export interface ParsedIntent {
  signerId: AccountId;
  deadline: number;
  intents: TransferIntent[];
  /** the hash that was signed */
  hash: Hex;
}

/** Check a signed payload's shape and signature. Returns null if anything is off. */
export function parseSignedIntent(s: SignedIntent): ParsedIntent | null {
  try {
    if (s.standard !== "nep413") return null;
    const hash = nep413Hash(s.payload.message, s.payload.recipient, fromBase64(s.payload.nonce));
    if (!verifyHash(hash, s.signature, s.public_key)) return null;
    const m = JSON.parse(s.payload.message) as IntentMessage;
    const deadline = Date.parse(m.deadline);
    if (typeof m.signer_id !== "string" || !Array.isArray(m.intents) || Number.isNaN(deadline)) return null;
    return { signerId: m.signer_id, deadline, intents: m.intents, hash: bytesToHex(hash) };
  } catch {
    return null;
  }
}

/** One line of an epoch's settlement plan, as a debtor sees it. */
export interface OrderTransfer {
  /** creditor agent id */
  to: string;
  receiver: AccountId;
  amount: string;
}

/** A net debt awaiting its debtor's signed transfer. */
export interface SettlementOrder {
  id: string;
  epoch: number;
  agentId: string;
  /** the debtor's NEAR account, the `signer_id` of the payload */
  account: AccountId;
  amount: string;
  token: AccountId;
  /** the coordinator contract that will check and forward the payload */
  contract: AccountId;
  verifier: AccountId;
  verifierKind: VerifierKind;
  deadline: number | null;
  transfers: OrderTransfer[];
}

/** Build and sign the payload that pays `order`, exactly as the contract expects it. */
export function signSettlement(order: SettlementOrder, secretKey: string, publicKey: PublicKey, now = Date.now()): SignedIntent {
  const tokenId = intentsTokenId(order.token);
  return signIntents({
    signerId: order.account,
    verifier: order.verifier,
    intents: order.transfers.map((t) => ({
      intent: "transfer" as const,
      receiver_id: t.receiver,
      tokens: { [tokenId]: t.amount },
      memo: `quorum epoch ${order.epoch}`,
    })),
    // long enough to outlive a slow epoch, short enough that a stale payload dies
    deadline: Math.max(now, order.deadline ?? now) + 6 * 3_600_000,
    nonce: settlementNonce(order.contract, order.epoch, order.agentId),
    secretKey,
    publicKey,
  });
}
