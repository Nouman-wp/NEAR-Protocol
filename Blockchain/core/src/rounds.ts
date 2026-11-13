import { bytesToHex, concatBytes, hexToBytes, sha256Bytes, u128le, u64le, type Hex } from "./crypto.ts";

/**
 * Sealed-bid rounds, mirrored from Blockchain/contracts/quorum/src/rounds.rs. The contract decides
 * every round; `clearRound` exists so services, tests and the Verify page can recompute
 * a result and compare.
 */

export type RoundKind = "Tender" | "GroupBuy";
export type Pricing = "FirstPrice" | "SecondPrice";
export type RoundStatus = "Open" | "Closed" | "Void";

const BID_DOMAIN = new TextEncoder().encode("quorum.bid.v1");

/** sha256("quorum.bid.v1" ++ round ++ seller ++ price ++ salt), integers little-endian. */
export function bidCommitment(round: bigint | number, seller: bigint | number, price: bigint, salt: Hex): Hex {
  const s = hexToBytes(salt);
  if (s.length !== 32) throw new Error("a bid salt is 32 bytes");
  return bytesToHex(sha256Bytes(concatBytes(BID_DOMAIN, u64le(BigInt(round)), u64le(BigInt(seller)), u128le(price), s)));
}

export interface RevealedBid {
  seller: string;
  /** null if the seller never revealed */
  price: bigint | null;
  reputation: number;
}

export interface RoundDemand {
  buyer: string;
  quantity: number;
  maxPrice: bigint;
}

export interface RoundOutcome {
  status: "Closed" | "Void";
  winner: string | null;
  clearingPrice: bigint;
  totalQuantity: number;
  allocations: { buyer: string; quantity: number; cost: bigint }[];
  voidReason: string;
}

/**
 * The contract's closing rule. Valid bids are revealed, positive, at or under the reserve
 * and from sellers at or above the reputation floor. The cheapest wins and ties go to the
 * earlier commitment (the order of `bids`). First price pays the winner's bid; second
 * price pays the lowest losing bid, or the reserve when the winner bid alone. Buyers whose
 * limit is under the clearing price drop out, and each remaining buyer pays quantity x price.
 */
export function clearRound(pricing: Pricing, reservePrice: bigint, minReputation: number, demand: RoundDemand[], bids: RevealedBid[]): RoundOutcome {
  const valid = bids
    .map((b, i) => ({ ...b, i }))
    .filter((b): b is typeof b & { price: bigint } => b.price !== null && b.price > 0n && b.price <= reservePrice && b.reputation >= minReputation)
    .sort((a, b) => (a.price === b.price ? a.i - b.i : a.price < b.price ? -1 : 1));
  const none = (voidReason: string): RoundOutcome => ({ status: "Void", winner: null, clearingPrice: 0n, totalQuantity: 0, allocations: [], voidReason });
  if (valid.length === 0) return none("no valid bid");
  const clearingPrice = pricing === "FirstPrice" ? valid[0]!.price : (valid[1]?.price ?? reservePrice);
  const allocations = demand.filter((d) => d.maxPrice >= clearingPrice).map((d) => ({ buyer: d.buyer, quantity: d.quantity, cost: clearingPrice * BigInt(d.quantity) }));
  if (allocations.length === 0) return none("no buyer accepts the clearing price");
  return {
    status: "Closed",
    winner: valid[0]!.seller,
    clearingPrice,
    totalQuantity: allocations.reduce((n, a) => n + a.quantity, 0),
    allocations,
    voidReason: "",
  };
}
