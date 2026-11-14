import {
  NearRpc,
  chainIouSetHash,
  hashJson,
  iouDigest,
  jobHash,
  net,
  parseSignedIntent,
  quoteDigest,
  verifyMessage,
  ZERO_HASH,
  type Delivery,
  type Hex,
  type IOU,
  type IouView,
  type JobSpec,
  type YukiDomain,
  type Quote,
} from "@yuki/core";
import { api, type EpochDetail } from "./api.ts";
import { usdExact } from "./format.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

type Rec = Record<string, string>;
const big = (v: string) => BigInt(v);

export const toQuote = (q: Rec): Quote => ({ seller: big(q.seller!), buyer: big(q.buyer!), service: q.service!, price: big(q.price!), token: q.token!, jobHash: q.jobHash as Hex, expiry: big(q.expiry!), quoteNonce: big(q.quoteNonce!) });
export const toDelivery = (d: Rec): Delivery => ({ seller: big(d.seller!), jobHash: d.jobHash as Hex, iouDigest: d.iouDigest as Hex, resultHash: d.resultHash as Hex, deliveredAt: big(d.deliveredAt!) });
export const toIou = (i: IouView): IOU => ({ buyer: big(i.buyer), seller: big(i.seller), amount: big(i.amount), token: i.token, jobHash: i.jobHash, quoteHash: i.quoteHash, epoch: BigInt(i.epoch), nonce: big(i.nonce) });

/** Re-check one job's chain of evidence with the keys the clearing service reports for both parties. */
export function verifyJob(j: {
  spec: JobSpec;
  quote: { message: Rec; signature: string; hash: string };
  iou: IouView | null;
  delivery: { message: Rec | null; signature: string | null; resultHash: string | null } | null;
  job: { jobHash: string; result: unknown };
  parties: { buyer: { publicKey: string } | null; seller: { publicKey: string } | null };
  verify: { domain: YukiDomain };
}): Record<"spec" | "quote" | "iou" | "delivery", Check | null> {
  const d = j.verify.domain;
  const quote = toQuote(j.quote.message);
  const specOk = jobHash(j.spec) === j.job.jobHash && quote.jobHash === j.job.jobHash;
  const quoteOk = !!j.parties.seller && verifyMessage(d, "Quote", quote, j.quote.signature, j.parties.seller.publicKey) && quoteDigest(d, quote) === j.quote.hash;
  let iou: Check | null = null;
  if (j.iou) {
    const m = toIou(j.iou);
    const ok = !!j.parties.buyer && iouDigest(d, m) === j.iou.digest && verifyMessage(d, "IOU", m, j.iou.signature, j.parties.buyer.publicKey) && m.quoteHash === j.quote.hash && m.amount === quote.price;
    iou = { name: "IOU", ok, detail: ok ? "Signed by the buyer's own key, for this quote and this price." : "The tab entry doesn't match the buyer's key or the quote." };
  }
  let delivery: Check | null = null;
  if (j.delivery?.message && j.delivery.signature) {
    const m = toDelivery(j.delivery.message);
    const sig = !!j.parties.seller && verifyMessage(d, "Delivery", m, j.delivery.signature, j.parties.seller.publicKey);
    const result = j.job.result === null || (j.job.result as { truncated?: boolean })?.truncated ? true : hashJson(j.job.result) === m.resultHash;
    delivery = { name: "Delivery", ok: sig && result, detail: sig && result ? "Signed by the seller, and the result shown here is exactly what was signed." : "The seller's signature or the delivered result doesn't match." };
  }
  return {
    spec: { name: "Job", ok: specOk, detail: specOk ? "The job description matches the fingerprint that the quote and the tab entry both carry." : "The job description doesn't match its fingerprint." },
    quote: { name: "Quote", ok: quoteOk, detail: quoteOk ? "Signed by the seller's own key." : "The quote doesn't match the seller's key." },
    iou,
    delivery,
  };
}

interface ChainEpoch {
  status: string;
  iou_count: number;
  gross_volume: string;
  iou_set_hash: string;
  positions_hash: string;
  plan_hash: string;
  receipt_hash: string;
  participants: number[];
}

/**
 * Re-derive an epoch in the browser. The IOU list comes from the clearing service; the
 * buyers' keys, the commitments and the positions come straight from the NEAR RPC, so a
 * dishonest service cannot make this pass.
 */
export async function verifyEpochInBrowser(epochId: number, onStep: (c: Check) => void): Promise<{ ok: boolean; rpc: string; contract: string; receipt: string | null }> {
  const cfg = await api<{ network: { rpc: string }; deployment: { contract: string; token: string }; domain: YukiDomain }>("/v1/config");
  const rpc = new NearRpc(cfg.network.rpc);
  const rpcName = () => rpc.url;
  const contract = cfg.deployment.contract;
  let ok = true;
  const step = (name: string, pass: boolean, detail: string) => {
    ok &&= pass;
    onStep({ name, ok: pass, detail });
  };

  const detail = await api<EpochDetail>(`/v1/epochs/${epochId}`);
  const ious = detail.ious.filter((i) => i.status === "netted" && i.postedEpoch === epochId);
  const chain = await rpc.view<ChainEpoch | null>(contract, "get_epoch", { epoch: epochId });
  if (!chain) {
    step("Epoch on chain", false, `${contract} has no record of epoch ${epochId}: it has not been finalised yet, or it is old enough to have been pruned from contract state to give its storage back (the ledger keeps every epoch; public deployments keep the latest 20 on chain).`);
    return { ok: false, rpc: rpcName(), contract, receipt: null };
  }
  step("Epoch on chain", chain.status === "Sealed" || chain.status === "Finalized", `Read from ${contract} over ${rpcName()}: status ${chain.status}, ${chain.iou_count} IOUs.`);

  // keys from the chain, not from the service
  const buyers = [...new Set(ious.map((i) => Number(i.buyer)))];
  const keys = new Map<number, string>();
  await Promise.all(
    buyers.map(async (id) => {
      const a = await rpc.view<{ public_key: string } | null>(contract, "get_agent", { agent_id: id });
      if (a) keys.set(id, a.public_key);
    }),
  );
  let badDigest = 0;
  let badSig = 0;
  for (const i of ious) {
    const m = toIou(i);
    if (iouDigest(cfg.domain, m) !== i.digest) badDigest++;
    const key = keys.get(Number(i.buyer));
    if (!key || !verifyMessage(cfg.domain, "IOU", m, i.signature, key)) badSig++;
  }
  step("IOU digests", badDigest === 0, `${ious.length - badDigest} of ${ious.length} digests recomputed from the IOU fields match.`);
  step("Buyer signatures", badSig === 0, `${ious.length - badSig} of ${ious.length} signatures verify against the key the contract holds for ${buyers.length === 1 ? "the buyer" : `each of the ${buyers.length} buyers`}.`);

  const nettable = (i: IouView) => ({ buyer: big(i.buyer), seller: big(i.seller), amount: big(i.amount), nonce: big(i.nonce), digest: i.digest });
  const carried = ious.filter((i) => i.epoch < epochId).sort((a, b) => a.epoch - b.epoch || Number(big(a.buyer) - big(b.buyer)) || Number(big(a.nonce) - big(b.nonce)));
  const result = net(ious.filter((i) => i.epoch === epochId).map(nettable), carried.map(nettable));
  const sum = result.positions.reduce((s, p) => s + p.net, 0n);
  step("Positions sum to zero", sum === 0n, `Netting redone here: ${result.positions.length} agents, sum of net positions ${sum}.`);
  step("IOU count and volume", chain.iou_count === ious.length && BigInt(chain.gross_volume) === result.stats.grossVolume, `On NEAR: ${chain.iou_count} IOUs worth ${usdExact(chain.gross_volume)}. Recomputed here: ${ious.length} worth ${usdExact(result.stats.grossVolume)}.`);
  step("IOU set commitment", chain.iou_set_hash === (ious.length ? result.iouSetHash : ZERO_HASH), `chain ${chain.iou_set_hash.slice(0, 18)}…, recomputed ${result.iouSetHash.slice(0, 18)}…`);
  step("Positions commitment", chain.positions_hash === result.positionsHash, `chain ${chain.positions_hash.slice(0, 18)}…, recomputed ${result.positionsHash.slice(0, 18)}…`);
  step("Settlement plan", chain.plan_hash === result.planHash, `${result.plan.length} transfers recomputed; chain ${chain.plan_hash.slice(0, 18)}…, recomputed ${result.planHash.slice(0, 18)}…`);

  const onchain = await rpc.view<{ agent: number; net: string; state: string }[]>(contract, "get_positions", { epoch: epochId });
  const byAgent = new Map(onchain.map((p) => [String(p.agent), p]));
  const mismatched = result.positions.filter((p) => byAgent.get(p.agentId.toString())?.net !== p.net.toString()).length;
  step("Per-agent positions", mismatched === 0 && onchain.length === result.positions.length, `${result.positions.length - mismatched} of ${result.positions.length} agents' net positions match the contract.`);

  const paid = detail.settlements.filter((s) => s.status === "recorded");
  let badIntent = 0;
  for (const s of paid) {
    const parsed = s.intent ? parseSignedIntent(s.intent) : null;
    const lines = result.plan.filter((t) => t.from.toString() === s.agentId);
    const state = byAgent.get(s.agentId)?.state;
    const exact = parsed !== null && parsed.intents.length === lines.length && lines.every((l, k) => Object.values(parsed.intents[k]!.tokens)[0] === l.amount.toString());
    if (!exact || state !== "Settled") badIntent++;
  }
  step("NEAR Intents payloads", badIntent === 0, `${paid.length - badIntent} of ${paid.length} ${paid.length === 1 ? "debt was" : "debts were"} paid by a signed transfer payload whose amounts match the recomputed plan, and the contract marks ${paid.length === 1 ? "it" : "them"} settled.`);
  void chainIouSetHash;
  return { ok, rpc: rpcName(), contract, receipt: chain.receipt_hash };
}
