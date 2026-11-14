/**
 * Wire types shared by the clearing service, the SDK, the MCP server and the web app.
 * Amounts travel as decimal strings of token base units; agent ids and epochs as strings
 * or numbers. Nothing here is a bigint, so it all survives JSON.
 */

import type { AccountId, Hex, PublicKey, Signature } from "./crypto.ts";
import type { SignedIntent, VerifierKind } from "./intents.ts";
import type { Pricing, RoundKind, RoundStatus } from "./rounds.ts";

export type EpochPhase =
  | "intake" // accepting IOUs
  | "challenge" // no new IOUs, disputes still allowed
  | "closing" // resolving disputes, netting, posting to chain
  | "settling" // waiting for debtors' signed NEAR Intents transfers
  | "sealed" // settled and receipted
  | "failed"; // something went wrong; retried automatically

export type SettlementStatus =
  | "awaiting_payment"
  | "submitted" // the debtor's signed transfer is in hand, waiting for the batch
  | "recorded" // executed by the verifier and marked settled by the contract
  | "defaulted"
  | "failed";


export interface ServiceListing {
  id: string; // e.g. "search"
  name: string;
  description: string;
  price: string; // base units per call
  unit: string; // "query", "claim", "paragraph", ...
  tags: string[];
}

export interface AgentSummary {
  agentId: string;
  slug: string;
  name: string;
  description: string;
  role: string;
  /** the agent's own NEAR account */
  account: AccountId;
  operator: AccountId;
  /** the ed25519 key that signs the agent's messages */
  publicKey: PublicKey;
  status: "active" | "paused" | "retired";
  endpoint: string;
  cardUrl: string;
  services: ServiceListing[];
  reputation: number; // 0..1000
  reputationEpoch: number;
  volumeSold: string;
  volumeBought: string;
  jobsSold: number;
  jobsBought: number;
  disputesLost: number;
  defaults: number;
  collateral: CollateralView;
  isValidator: boolean;
  isFleet: boolean;
}

export interface CollateralView {
  total: string;
  locked: string;
  pendingWithdrawal: string;
  unlockAt: number;
  /** total - locked - pending: what can still back new IOUs */
  available: string;
  /** unsettled obligations the clearing service is holding against it right now */
  exposure: string;
  /** available - exposure */
  headroom: string;
}

export interface IouView {
  digest: Hex;
  epoch: number;
  buyer: string;
  seller: string;
  amount: string;
  token: AccountId;
  jobHash: Hex;
  quoteHash: Hex;
  nonce: string;
  signature: Signature;
  status: "pending" | "disputed" | "voided" | "held_out" | "carried" | "posted" | "netted";
  createdAt: number;
  jobId: string;
  /** the epoch whose netting counted this IOU, once it has been posted */
  postedEpoch: number | null;
}

export interface JobView {
  id: string;
  jobHash: Hex;
  buyer: string;
  seller: string;
  service: string;
  input: unknown;
  price: string;
  epoch: number;
  intentId: string | null;
  status: "quoted" | "accepted" | "delivered" | "disputed" | "voided" | "settled" | "refused";
  createdAt: number;
  deliveredAt: number | null;
  challengeEndsAt: number | null;
  resultHash: Hex | null;
  result: unknown;
  /** the sealed-bid round that set the price, if any */
  roundId: number | null;
}

export interface EpochView {
  id: number;
  phase: EpochPhase;
  startsAt: number;
  intakeEndsAt: number;
  challengeEndsAt: number;
  settleDeadline: number | null;
  iouCount: number;
  grossVolume: string;
  netVolume: string;
  debtors: number;
  creditors: number;
  settlementTransfers: number;
  transfersAvoided: number;
  transferReduction: number;
  volumeReduction: number;
  iouSetHash: Hex | null;
  positionsHash: Hex | null;
  receiptHash: Hex | null;
  planHash: Hex | null;
  finalizeTx: string | null;
  /** the transaction that carried the NEAR Intents batch */
  settleTx: string | null;
  heldOut: number;
  carried: number;
  disputesUpheld: number;
  defaults: number;
  onchain: "pending" | "posting" | "finalized" | "settled" | "failed" | "skipped";
  error: string | null;
}

export interface PositionView {
  epoch: number;
  agentId: string;
  credit: string;
  debit: string;
  net: string;
  state: "flat" | "owes" | "settled" | "defaulted" | "creditor" | "paid";
}

export interface TransferView {
  epoch: number;
  from: string;
  to: string;
  amount: string;
  /** how the line was paid: through the verifier, or from seized collateral */
  status: "planned" | "settled" | "defaulted";
  tx: string | null;
}

export interface SettlementView {
  id: string;
  epoch: number;
  agentId: string;
  amount: string;
  status: SettlementStatus;
  verifier: AccountId;
  verifierKind: VerifierKind;
  /** the debtor's signed NEAR Intents payload, once it has arrived */
  intent: SignedIntent | null;
  /** hash of the signed payload */
  intentHash: Hex | null;
  /** the `settle` transaction that executed it */
  settleTx: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  deadline: number | null;
  error: string | null;
}

export interface DisputeView {
  id: string;
  jobId: string;
  iouDigest: Hex;
  epoch: number;
  buyer: string;
  seller: string;
  validator: string | null;
  reason: string;
  status: "open" | "upheld" | "rejected" | "expired";
  reasoning: string | null;
  filedAt: number;
  decidedAt: number | null;
  disputeHash: Hex;
  verdictSignature: Signature | null;
  onchainRequestTx: string | null;
  onchainResponseTx: string | null;
}

export interface IntentView {
  id: Hex; // intent digest
  operator: AccountId;
  buyer: string;
  goal: string;
  budget: string;
  spent: string;
  perJobCap: string;
  minSellerReputation: number;
  allowedServices: string[];
  allowedSellers: string[];
  notBefore: number;
  deadline: number;
  status: "active" | "revoked" | "expired" | "exhausted";
  createdAt: number;
  revokedAt: number | null;
  jobs: number;
  refusals: number;
}

export interface HeadlineStats {
  agents: number;
  jobsCleared: number;
  iousCleared: number;
  epochsSealed: number;
  grossVolume: string;
  netVolume: string;
  /** value moved by NEAR Intents transfers */
  valueSettled: string;
  intentTransfers: number;
  roundsClosed: number;
  transfersAvoided: number;
  transferReduction: number;
  currentEpoch: number;
  epochPhase: EpochPhase;
  phaseEndsAt: number;
  network: { key: string; name: string; explorer: string | null };
  intents: { account: AccountId; kind: VerifierKind; healthy: boolean; note: string };
  deployment: Record<string, string> | null;
}

/** Events pushed over the live WebSocket. */
export type LiveEvent =
  | { type: "hello"; at: number; stats: HeadlineStats }
  | { type: "stats"; at: number; stats: HeadlineStats }
  | { type: "iou.accepted"; at: number; iou: IouView; job: JobView }
  | { type: "iou.refused"; at: number; buyer: string; seller: string; amount: string; service: string; reason: string; intentId: string | null }
  | { type: "job.delivered"; at: number; job: JobView }
  | { type: "dispute.opened"; at: number; dispute: DisputeView }
  | { type: "dispute.resolved"; at: number; dispute: DisputeView }
  | { type: "epoch.phase"; at: number; epoch: EpochView }
  | { type: "epoch.netted"; at: number; epoch: EpochView; positions: PositionView[] }
  | { type: "settlement.update"; at: number; settlement: SettlementView }
  | { type: "epoch.settled"; at: number; epoch: number; transfers: TransferView[] }
  | { type: "round"; at: number; round: RoundView }
  | { type: "reputation"; at: number; epoch: number; scores: { agentId: string; score: number; previous: number }[] }
  | { type: "intent"; at: number; intent: IntentView }
  | { type: "log"; at: number; level: "info" | "warn" | "error"; source: string; message: string };

export interface RoundBidView {
  seller: string;
  commitment: Hex;
  committedAt: number;
  /** hidden until the seller reveals */
  price: string | null;
  revealedAt: number | null;
  /** why a revealed bid did not count, if it did not */
  invalid: string | null;
}

export interface RoundView {
  id: number;
  kind: RoundKind;
  pricing: Pricing;
  status: RoundStatus;
  /** where the round is in its life, by the clock */
  phase: "joining" | "committing" | "revealing" | "closing" | "closed" | "void";
  opener: string;
  service: string;
  title: string;
  /** the job specification, once someone has posted the preimage of `specHash` */
  spec: unknown;
  specHash: Hex;
  reservePrice: string;
  minReputation: number;
  openedAt: number;
  joinDeadline: number;
  commitDeadline: number;
  revealDeadline: number;
  closedAt: number | null;
  demand: { buyer: string; quantity: number; maxPrice: string }[];
  bids: RoundBidView[];
  winner: string | null;
  clearingPrice: string | null;
  totalQuantity: number;
  allocations: { buyer: string; quantity: number; cost: string; jobId: string | null }[];
  voidReason: string | null;
  /** what the buyers would have paid at the reserve, minus what they pay */
  savings: string | null;
  openTx: string | null;
  closeTx: string | null;
}

/** A2A agent card (subset of the A2A spec) with Yuki's pricing extension. */
export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: "JSONRPC";
  version: string;
  provider: { organization: string; url: string };
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extensions: { uri: string; description: string; required: boolean; params: YukiPricingExtension }[];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[]; examples?: string[] }[];
}

export const YUKI_PRICING_EXTENSION = "https://github.com/Nouman-wp/NEAR-Protocol/blob/main/docs/pricing-extension.md";

export interface YukiPricingExtension {
  agentId: string;
  account: AccountId;
  network: string;
  contract: AccountId;
  token: AccountId;
  clearingApi: string;
  prices: Record<string, { price: string; unit: string }>;
}

/** The registration document an agent's on-chain `uri` points at. */
export interface AgentRegistration {
  type: "yuki-agent-registration-v1";
  name: string;
  description: string;
  image: string;
  endpoints: { name: string; endpoint: string; version?: string }[];
  registrations: { agentId: number; account: AccountId; contract: AccountId }[];
  supportedTrust: string[];
}
