import type { LiveState } from "./api.ts";
import type { OrbitEdge } from "../components/Orbit.tsx";

/** Who owes whom in the open epoch, aggregated from the signed IOUs seen so far. */
export function openDebts(s: LiveState): { edges: OrbitEdge[]; active: Map<string, number>; gross: bigint; count: number } {
  const epoch = s.stats?.currentEpoch;
  const current = s.ious.filter((x) => x.iou.epoch === epoch && x.iou.status !== "voided");
  // between epochs the floor would be empty: show the tail of the last one instead
  const ious = current.length ? current : s.ious.slice(0, 80);
  const map = new Map<string, OrbitEdge>();
  const active = new Map<string, number>();
  let gross = 0n;
  for (const { iou, at } of ious) {
    const key = `${iou.buyer}>${iou.seller}`;
    const e = map.get(key) ?? { from: iou.buyer, to: iou.seller, amount: 0n, count: 0 };
    e.amount += BigInt(iou.amount);
    e.count++;
    map.set(key, e);
    gross += BigInt(iou.amount);
    for (const id of [iou.buyer, iou.seller]) if ((active.get(id) ?? 0) < at) active.set(id, at);
  }
  return { edges: [...map.values()], active, gross, count: current.length };
}
