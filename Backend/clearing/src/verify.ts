import { iouDigest, net, parseSignedIntent, verifyMessage, type Hex, type IOU, type QuorumDomain, type SignedIntent } from "@quorum/core";
import type { Db } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { Registry } from "./registry.ts";
import type { IouRow, SettlementRow, TransferRow } from "./views.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Independent re-check of an epoch against the chain, using only the published IOU set:
 * every digest is recomputed, every signature verified against the buyer's registered
 * key, the netting and the settlement plan redone, and the resulting commitments and
 * per-agent positions compared with what the coordinator contract stored. The debtors'
 * signed NEAR Intents payloads are checked against the plan line by line.
 */
export async function verifyEpoch(db: Db, chain: Chain, registry: Registry, domain: QuorumDomain, epochId: number) {
  const checks: Check[] = [];
  const ious = db.all<IouRow>("SELECT * FROM ious WHERE posted_epoch = ? AND status = 'netted' ORDER BY epoch, buyer, nonce_num", epochId);
  const carried = ious.filter((i) => i.epoch < epochId);
  const own = ious.filter((i) => i.epoch === epochId);

  let badSigs = 0;
  let badDigests = 0;
  for (const r of ious) {
    const iou: IOU = {
      buyer: BigInt(r.buyer),
      seller: BigInt(r.seller),
      amount: BigInt(r.amount),
      token: r.token,
      jobHash: r.job_hash as Hex,
      quoteHash: r.quote_hash as Hex,
      epoch: BigInt(r.epoch),
      nonce: BigInt(r.nonce),
    };
    if (iouDigest(domain, iou) !== r.digest) badDigests++;
    const key = registry.get(r.buyer)?.publicKey;
    if (!key || !verifyMessage(domain, "IOU", iou, r.signature, key)) badSigs++;
  }
  checks.push({ name: "IOU digests", ok: badDigests === 0, detail: `${ious.length - badDigests}/${ious.length} recomputed digests match` });
  checks.push({ name: "Buyer signatures", ok: badSigs === 0, detail: `${ious.length - badSigs}/${ious.length} signatures verify against the buyer's registered key` });

  const toNettable = (r: IouRow) => ({ buyer: BigInt(r.buyer), seller: BigInt(r.seller), amount: BigInt(r.amount), nonce: BigInt(r.nonce), digest: r.digest as Hex });
  const result = net(own.map(toNettable), carried.map(toNettable));
  const sum = result.positions.reduce((a, p) => a + p.net, 0n);
  checks.push({ name: "Positions sum to zero", ok: sum === 0n, detail: `sum of net positions = ${sum}` });

  const ce = await chain.epoch(epochId);
  if (!ce) {
    checks.push({ name: "Epoch on chain", ok: false, detail: "the coordinator contract has no record of this epoch yet" });
    return { epoch: epochId, ok: false, chainStatus: "unknown", receiptHash: null, checks, stats: { ...result.stats, grossVolume: result.stats.grossVolume.toString(), netVolume: result.stats.netVolume.toString() } };
  }
  checks.push({ name: "IOU-set commitment", ok: ce.iou_set_hash === result.iouSetHash, detail: `chain ${ce.iou_set_hash} / recomputed ${result.iouSetHash}` });
  checks.push({ name: "Positions commitment", ok: ce.positions_hash === result.positionsHash, detail: `chain ${ce.positions_hash} / recomputed ${result.positionsHash}` });
  checks.push({ name: "Settlement plan", ok: ce.plan_hash === result.planHash, detail: `chain ${ce.plan_hash} / recomputed ${result.planHash} (${result.plan.length} transfers)` });
  checks.push({ name: "Gross volume", ok: BigInt(ce.gross_volume) === result.stats.grossVolume, detail: `chain ${ce.gross_volume} / recomputed ${result.stats.grossVolume}` });
  checks.push({ name: "IOU count", ok: ce.iou_count === result.stats.iouCount, detail: `chain ${ce.iou_count} / recomputed ${result.stats.iouCount}` });

  let posMismatch = 0;
  for (const p of result.positions) {
    const onchain = await chain.position(epochId, p.agentId);
    if (!onchain || onchain.net !== p.net) posMismatch++;
  }
  checks.push({ name: "Per-agent net positions", ok: posMismatch === 0, detail: `${result.positions.length - posMismatch}/${result.positions.length} agents match the chain` });

  const settlements = db.all<SettlementRow>("SELECT * FROM settlements WHERE epoch = ? AND status = 'recorded'", epochId);
  const lines = db.all<TransferRow>("SELECT * FROM transfers WHERE epoch = ? ORDER BY seq", epochId);
  let badIntents = 0;
  for (const s of settlements) {
    const agent = registry.get(s.agent_id);
    const parsed = s.intent_json ? parseSignedIntent(JSON.parse(s.intent_json) as SignedIntent) : null;
    const mine = lines.filter((l) => l.from_agent === s.agent_id);
    const exact =
      parsed !== null &&
      agent !== undefined &&
      parsed.signerId === agent.account &&
      parsed.intents.length === mine.length &&
      mine.every((l, i) => {
        const got = parsed.intents[i]!;
        return got.receiver_id === registry.get(l.to_agent)?.account && got.tokens[`nep141:${chain.d.token}`] === String(l.amount);
      });
    const state = await chain.position(epochId, s.agent_id).catch(() => null);
    if (!exact || state?.state !== "Settled") badIntents++;
  }
  checks.push({
    name: "NEAR Intents settlement",
    ok: badIntents === 0,
    detail: `${settlements.length - badIntents}/${settlements.length} debts were paid by a signed transfer payload that matches the plan line for line, and the contract marks them settled`,
  });

  return {
    epoch: epochId,
    ok: checks.every((c) => c.ok),
    chainStatus: ce.status.toLowerCase(),
    receiptHash: ce.receipt_hash,
    checks,
    stats: { ...result.stats, grossVolume: result.stats.grossVolume.toString(), netVolume: result.stats.netVolume.toString() },
  };
}
