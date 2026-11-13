import { bytesToHex, canonicalJson, nep413Hash, signHash, verifyHash, type AccountId, type Hex, type PublicKey, type Signature } from "./crypto.ts";

/**
 * Every Quorum message is canonical JSON signed under NEP-413, with the coordinator
 * contract's account as the recipient. A signature made for one deployment is therefore
 * useless on any other. The IOU message is byte for byte what the contract rebuilds and
 * verifies on chain (`iou_message` in Blockchain/contracts/quorum/src/epochs.rs).
 */
export interface QuorumDomain {
  /** "local", "testnet" or "mainnet" */
  network: string;
  /** The coordinator contract. It is the NEP-413 recipient of every message. */
  contract: AccountId;
}

export type MessageKind = "IOU" | "Quote" | "Delivery" | "IntentMandate" | "IntentRevocation" | "Dispute" | "Verdict";

// ------------------------------------------------------------------ message shapes

export interface IOU {
  buyer: bigint;
  seller: bigint;
  amount: bigint;
  /** the NEP-141 settlement token's account */
  token: AccountId;
  jobHash: Hex;
  quoteHash: Hex;
  epoch: bigint;
  nonce: bigint;
}

/** A seller's binding offer: price, job and expiry. The quote wins over later price changes. */
export interface Quote {
  seller: bigint;
  buyer: bigint;
  service: string;
  price: bigint;
  token: AccountId;
  jobHash: Hex;
  expiry: bigint;
  quoteNonce: bigint;
}

/** The seller's signed statement that it delivered `resultHash` for the job. */
export interface Delivery {
  seller: bigint;
  jobHash: Hex;
  iouDigest: Hex;
  resultHash: Hex;
  deliveredAt: bigint;
}

/**
 * AP2-style Intent Mandate: a human operator authorises a buyer agent to spend up to a
 * budget for a goal, before a deadline, inside limits. Empty arrays mean "no restriction".
 * `operatorKey` must be an access key of the `operator` account, which anyone can check
 * against the chain.
 */
export interface IntentMandate {
  operator: AccountId;
  operatorKey: PublicKey;
  buyer: bigint;
  goal: string;
  budget: bigint;
  perJobCap: bigint;
  minSellerReputation: number;
  allowedServices: string[];
  allowedSellers: bigint[];
  notBefore: bigint;
  deadline: bigint;
  nonce: bigint;
}

export interface IntentRevocation {
  intentHash: Hex;
  revokedAt: bigint;
}

/** A buyer's challenge of a delivered job, filed inside the challenge window. */
export interface Dispute {
  buyer: bigint;
  jobHash: Hex;
  iouDigest: Hex;
  reason: string;
  filedAt: bigint;
}

/** A validator's ruling. upheld = the seller's work failed and the IOU is voided. */
export interface Verdict {
  disputeHash: Hex;
  validator: bigint;
  upheld: boolean;
  reasoning: string;
  decidedAt: bigint;
}

export interface MessageOf {
  IOU: IOU;
  Quote: Quote;
  Delivery: Delivery;
  IntentMandate: IntentMandate;
  IntentRevocation: IntentRevocation;
  Dispute: Dispute;
  Verdict: Verdict;
}

// ------------------------------------------------------------------ text, digest, signature

/** The exact text that is signed: the message with a `type` field, as canonical JSON. */
export function messageText<K extends MessageKind>(kind: K, message: MessageOf[K]): string {
  return canonicalJson({ ...message, type: kind });
}

/** The NEP-413 hash of a message: what the signer signs and what identifies the message. */
export function messageDigest<K extends MessageKind>(domain: QuorumDomain, kind: K, message: MessageOf[K]): Hex {
  return bytesToHex(nep413Hash(messageText(kind, message), domain.contract));
}

export function signMessage<K extends MessageKind>(domain: QuorumDomain, kind: K, message: MessageOf[K], secretKey: string): Signature {
  return signHash(messageDigest(domain, kind, message), secretKey);
}

export function verifyMessage<K extends MessageKind>(domain: QuorumDomain, kind: K, message: MessageOf[K], signature: Signature, publicKey: PublicKey): boolean {
  return verifyHash(messageDigest(domain, kind, message), signature, publicKey);
}

export const iouDigest = (d: QuorumDomain, m: IOU): Hex => messageDigest(d, "IOU", m);
export const quoteDigest = (d: QuorumDomain, m: Quote): Hex => messageDigest(d, "Quote", m);
export const deliveryDigest = (d: QuorumDomain, m: Delivery): Hex => messageDigest(d, "Delivery", m);
export const intentDigest = (d: QuorumDomain, m: IntentMandate): Hex => messageDigest(d, "IntentMandate", m);
export const revocationDigest = (d: QuorumDomain, m: IntentRevocation): Hex => messageDigest(d, "IntentRevocation", m);
export const disputeDigest = (d: QuorumDomain, m: Dispute): Hex => messageDigest(d, "Dispute", m);
export const verdictDigest = (d: QuorumDomain, m: Verdict): Hex => messageDigest(d, "Verdict", m);
