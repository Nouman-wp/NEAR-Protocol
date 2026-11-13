import { ZERO_HASH, bytesToHex, concatBytes, hexToBytes, sha256Bytes, u128le, u64le, type Hex } from "./crypto.ts";

/**
 * Off-chain mirror of the coordinator contract's netting. The clearing service uses it to
 * compute the result it expects before posting; the Verify page and the CLI verifier use
 * it to re-derive an epoch from the published IOU set. All three must agree with the
 * contract bit for bit, which is what the parity tests check.
 */

export interface NettableIou {
  buyer: bigint;
  seller: bigint;
  amount: bigint;
  nonce: bigint;
  digest: Hex;
}

export interface Position {
  agentId: bigint;
  credit: bigint;
  debit: bigint;
  net: bigint;
}

export interface NettingResult {
  /** IOUs in the exact order they are posted on chain (carried first, then sorted). */
  ordered: NettableIou[];
  positions: Position[];
  iouSetHash: Hex;
  positionsHash: Hex;
  plan: PlanTransfer[];
  planHash: Hex;
  stats: CompressionStats;
}

export interface CompressionStats {
  iouCount: number;
  grossVolume: bigint;
  netVolume: bigint;
  debtors: number;
  creditors: number;
  /** Transfers that actually move money: the lines of the settlement plan. */
  settlementTransfers: number;
  /** How many individual payments netting removed. Never negative. */
  transfersAvoided: number;
  /** Share of payments avoided, 0..1. A single IOU honestly shows 0. */
  transferReduction: number;
  /** Share of value that never had to move, 0..1. */
  volumeReduction: number;
}

/** Posting order the contract requires: strictly ascending (buyer, nonce). */
export function sortForPosting<T extends { buyer: bigint; nonce: bigint }>(ious: T[]): T[] {
  return [...ious].sort((a, b) => {
    if (a.buyer !== b.buyer) return a.buyer < b.buyer ? -1 : 1;
    if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1;
    return 0;
  });
}

/** sha256(prev ++ digest): the running commitment to the posted IOU set. */
/** sha256(prev ++ digest): the running commitment to the posted IOU set. */
export function chainIouSetHash(prev: Hex, digest: Hex): Hex {
  return bytesToHex(sha256Bytes(concatBytes(hexToBytes(prev), hexToBytes(digest))));
}

/** sha256(prev ++ agent ++ credit ++ debit), integers little-endian as the contract hashes them. */
export function chainPositionsHash(prev: Hex, agentId: bigint, credit: bigint, debit: bigint): Hex {
  return bytesToHex(sha256Bytes(concatBytes(hexToBytes(prev), u64le(agentId), u128le(credit), u128le(debit))));
}

export interface PlanTransfer {
  from: bigint;
  to: bigint;
  amount: bigint;
}

/**
 * The transfers that settle an epoch: every creditor is paid by the debtors in order, so
 * there are at most debtors + creditors - 1 of them and no pool in between. The contract
 * computes the same plan at finalisation (`settlement_plan`) and only accepts NEAR Intents
 * transfers that match it line for line.
 */
export function settlementPlan(positions: Position[]): PlanTransfer[] {
  const debtors = positions.filter((p) => p.net < 0n).map((p) => ({ id: p.agentId, left: -p.net }));
  const creditors = positions.filter((p) => p.net > 0n).map((p) => ({ id: p.agentId, left: p.net }));
  const plan: PlanTransfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d]!;
    const creditor = creditors[c]!;
    const amount = debtor.left < creditor.left ? debtor.left : creditor.left;
    plan.push({ from: debtor.id, to: creditor.id, amount });
    debtor.left -= amount;
    creditor.left -= amount;
    if (debtor.left === 0n) d++;
    if (creditor.left === 0n) c++;
  }
  return plan;
}

export function planHash(plan: PlanTransfer[]): Hex {
  let h: Hex = ZERO_HASH;
  for (const t of plan) h = bytesToHex(sha256Bytes(concatBytes(hexToBytes(h), u64le(t.from), u64le(t.to), u128le(t.amount))));
  return h;
}

/**
 * Net an epoch. `carried` are held-out IOUs from earlier epochs whose disputes were
 * rejected; they are posted first, in the given order. `ious` are this epoch's IOUs and
 * are sorted here. Throws on duplicates, which the contract would reject anyway.
 */
export function net(ious: NettableIou[], carried: NettableIou[] = []): NettingResult {
  const sorted = sortForPosting(ious);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (a.buyer === b.buyer && a.nonce === b.nonce) {
      throw new Error(`duplicate IOU nonce ${b.nonce} for buyer ${b.buyer}`);
    }
  }
  const ordered = [...carried, ...sorted];

  const order: bigint[] = [];
  const book = new Map<bigint, { credit: bigint; debit: bigint }>();
  const touch = (id: bigint) => {
    let p = book.get(id);
    if (!p) {
      p = { credit: 0n, debit: 0n };
      book.set(id, p);
      order.push(id);
    }
    return p;
  };

  let iouSetHash: Hex = ZERO_HASH;
  let gross = 0n;
  for (const iou of ordered) {
    if (iou.buyer === iou.seller) throw new Error(`self-dealing IOU for agent ${iou.buyer}`);
    if (iou.amount <= 0n) throw new Error("IOU amount must be positive");
    touch(iou.buyer).debit += iou.amount;
    touch(iou.seller).credit += iou.amount;
    gross += iou.amount;
    iouSetHash = chainIouSetHash(iouSetHash, iou.digest);
  }

  let positionsHash: Hex = ZERO_HASH;
  const positions: Position[] = [];
  let netVolume = 0n;
  let debtors = 0;
  let creditors = 0;
  let sum = 0n;
  for (const id of order) {
    const p = book.get(id)!;
    const n = p.credit - p.debit;
    positions.push({ agentId: id, credit: p.credit, debit: p.debit, net: n });
    positionsHash = chainPositionsHash(positionsHash, id, p.credit, p.debit);
    sum += n;
    if (n < 0n) debtors++;
    if (n > 0n) {
      creditors++;
      netVolume += n;
    }
  }
  if (sum !== 0n) throw new Error(`netting invariant broken: positions sum to ${sum}`);

  const plan = settlementPlan(positions);
  return { ordered, positions, iouSetHash, positionsHash, plan, planHash: planHash(plan), stats: compression(ordered.length, gross, netVolume, debtors, creditors, plan.length) };
}

export function compression(
  iouCount: number,
  grossVolume: bigint,
  netVolume: bigint,
  debtors: number,
  creditors: number,
  planTransfers?: number,
): CompressionStats {
  // Debtors pay creditors directly, so the plan needs at most debtors + creditors - 1 transfers.
  const settlementTransfers = planTransfers ?? Math.max(0, debtors + creditors - 1);
  // Without netting every IOU is one payment, so we compare against the gross count.
  const transfersAvoided = Math.max(0, iouCount - settlementTransfers);
  return {
    iouCount,
    grossVolume,
    netVolume,
    debtors,
    creditors,
    settlementTransfers,
    transfersAvoided,
    transferReduction: iouCount === 0 ? 0 : transfersAvoided / iouCount,
    volumeReduction: grossVolume === 0n ? 0 : Number(grossVolume - netVolume) / Number(grossVolume),
  };
}
