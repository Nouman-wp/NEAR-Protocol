import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { DisputeView, EpochView, IouView, JobSpec, JobView, PositionView, QuorumDomain, RoundView, SettlementView, TransferView } from "@quorum/core";
import { useApi } from "../lib/api.ts";
import { verifyJob, type Check } from "../lib/verify.ts";
import { plural, serviceName, signedUsd, usd, when } from "../lib/format.ts";
import { AgentChip, Details, Hash, Loading, Money, PageHead, Status, Tx } from "../components/ui.tsx";

interface JobDetail {
  job: JobView;
  spec: JobSpec;
  quote: { message: Record<string, string>; signature: string; hash: string };
  iou: (IouView & { postedEpoch: number | null }) | null;
  delivery: { deliveredAt: number; resultHash: string | null; signature: string | null; challengeEndsAt: number | null; message: Record<string, string> | null } | null;
  dispute: DisputeView | null;
  epoch: EpochView | null;
  positions: { buyer: PositionView | null; seller: PositionView | null };
  buyerSettlement: SettlementView | null;
  sellerReceipts: TransferView[];
  round: RoundView | null;
  parties: { buyer: { publicKey: string; account: string } | null; seller: { publicKey: string; account: string } | null };
  parent: JobView | null;
  children: JobView[];
  verify: { domain: QuorumDomain };
}

function Step({ title, check, pending, children }: { title: string; check?: Check | null; pending?: boolean; children: ReactNode }) {
  return (
    <div className={`link-step${check ? (check.ok ? " ok" : " fail") : pending ? "" : " ok"}`}>
      <h3 className="step-title">{title}</h3>
      <div className="muted stack stack-sm" style={{ fontSize: 15 }}>
        {children}
        {check && (
          <span style={{ color: check.ok ? "var(--good)" : "var(--bad)" }}>
            {check.ok ? "✓ Checked in your browser. " : "✗ Doesn't check out. "}
            {check.detail}
          </span>
        )}
      </div>
    </div>
  );
}

const label = (k: string) => {
  const w = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase();
  return w[0]!.toUpperCase() + w.slice(1);
};

/** A short, readable summary of a request or result: simple fields as they are, lists and objects counted. */
function Summary({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="muted">Nothing yet.</p>;
  if (typeof value !== "object") return <p>{String(value)}</p>;
  const rows = Array.isArray(value) ? [["Items", value]] : Object.entries(value as Record<string, unknown>);
  return (
    <dl className="kv">
      {rows.slice(0, 10).map(([k, v]) => (
        <div key={String(k)} style={{ display: "contents" }}>
          <dt>{label(String(k))}</dt>
          <dd>
            {v === null || v === undefined
              ? "–"
              : Array.isArray(v)
                ? plural(v.length, "item")
                : typeof v === "object"
                  ? Object.keys(v as object).length + " details"
                  : String(v).length > 120
                    ? `${String(v).slice(0, 119)}…`
                    : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function JobPage() {
  const { id } = useParams();
  const { data, error } = useApi<JobDetail>(`/v1/jobs/${id}`, 4_000);
  const checks = useMemo(() => {
    try {
      return data ? verifyJob(data) : null;
    } catch {
      return null;
    }
  }, [data]);
  if (!data) return <Loading error={error} what="this job" />;
  const { job, iou, dispute, epoch } = data;
  const sealed = epoch?.phase === "sealed" && iou?.status === "netted";
  const name = serviceName(job.service);
  return (
    <main className="page">
      <div className="wrap">
        <PageHead
          back={epoch ? { to: `/epochs/${epoch.id}`, label: `Settle-up ${epoch.id}` } : data.round ? { to: `/rounds/${data.round.id}`, label: `Auction #${data.round.id}` } : { to: "/floor", label: "Live" }}
          eyebrow={`${name} job`}
          title={
            <>
              {usd(job.price)} for one {name.toLowerCase()} job
            </>
          }
          lead="Every step behind one payment, from the auction that set the price to the payment that settled it. Each signature is checked again in your browser."
        >
          <Status value={job.status} />
        </PageHead>
        <div className="grid split balance">
          <div className="card">
            <div className="chain">
              {data.round && (
                <Step title="Price set">
                  <span>
                    {plural(data.round.bids.length, "secret bid")} in auction #{data.round.id}. <AgentChip id={data.round.winner} /> won at {usd(data.round.clearingPrice)}.{" "}
                    <Link className="link" to={`/rounds/${data.round.id}`}>
                      See the bids →
                    </Link>
                  </span>
                </Step>
              )}
              <Step title="Job agreed" check={checks?.spec}>
                <span>
                  <AgentChip id={job.buyer} /> asked <AgentChip id={job.seller} /> for a {name.toLowerCase()} on {when(job.createdAt)}.
                </span>
              </Step>
              <Step title="Seller's quote" check={checks?.quote}>
                <span>
                  {usd(data.quote.message.price)}, good until {when(Number(data.quote.message.expiry) * 1000)}.
                </span>
              </Step>
              <Step title="Added to the tab" check={checks?.iou} pending={!iou}>
                {iou ? (
                  <span>
                    A signed promise to pay {usd(iou.amount)} in settle-up {iou.epoch}. <Status value={iou.status} />
                  </span>
                ) : (
                  <span>Nothing was added to the tab for this job.</span>
                )}
              </Step>
              <Step title="Delivered" check={checks?.delivery} pending={!data.delivery}>
                {data.delivery ? (
                  <span>
                    {when(data.delivery.deliveredAt)}. The buyer could complain until {when(data.delivery.challengeEndsAt)}.
                  </span>
                ) : (
                  <span>Not delivered yet. A job that is never delivered is cancelled when its settle-up closes, and nobody pays for it.</span>
                )}
              </Step>
              {dispute && (
                <Step title={`Complaint ${dispute.status === "upheld" ? "accepted" : dispute.status === "rejected" ? "rejected" : "open"}`}>
                  <span>Buyer's reason: {dispute.reason}</span>
                  {dispute.reasoning && (
                    <span>
                      <AgentChip id={dispute.validator} /> ruled: {dispute.reasoning.replace(/\b(\w+)\(s\)/g, (_, w: string) => `${w}s`)}
                    </span>
                  )}
                </Step>
              )}
              <Step title="Settled up" pending={!sealed && epoch?.phase !== "settling"}>
                {epoch && iou?.status === "netted" ? (
                  <>
                    <span>
                      One of {plural(epoch.iouCount, "tab entry", "tab entries")} that became {plural(epoch.settlementTransfers, "payment")}.{" "}
                      <Link className="link" to={`/epochs/${epoch.id}`}>
                        See settle-up {epoch.id} →
                      </Link>
                    </span>
                    <span>
                      Buyer's total for the settle-up: {data.positions.buyer ? signedUsd(data.positions.buyer.net) : "–"}. Seller's: {data.positions.seller ? signedUsd(data.positions.seller.net) : "–"}.
                    </span>
                  </>
                ) : (
                  <span>{iou?.status === "voided" ? "Cancelled: this was taken off the tab, and nobody paid for it." : `Waiting for settle-up ${job.epoch} to close.`}</span>
                )}
              </Step>
              <Step title="Paid" pending={!sealed}>
                {data.buyerSettlement ? (
                  <span>
                    The buyer paid its whole total of {usd(data.buyerSettlement.amount)} for the settle-up. <Status value={data.buyerSettlement.status} />{" "}
                    {data.buyerSettlement.settleTx && <Tx hash={data.buyerSettlement.settleTx} label="See on NEAR ↗" />}
                  </span>
                ) : (
                  <span>{sealed ? "The buyer didn't have to pay anything: what it sold covered what it bought." : "Not paid yet."}</span>
                )}
                {data.sellerReceipts.map((t, i) => (
                  <span key={i}>
                    The seller received {usd(t.amount)} from <AgentChip id={t.from} />. {t.tx && <Tx hash={t.tx} label="See on NEAR ↗" />}
                  </span>
                ))}
              </Step>
            </div>
            <Details summary="Show proof">
              <dl className="kv">
                <dt>Job id</dt>
                <dd>
                  <Hash value={job.id} />
                </dd>
                <dt>Job fingerprint</dt>
                <dd>
                  <Hash value={job.jobHash} />
                </dd>
                {iou && (
                  <>
                    <dt>Tab entry fingerprint</dt>
                    <dd>
                      <Hash value={iou.digest} />
                    </dd>
                    <dt>Tab entry number</dt>
                    <dd className="mono">{iou.nonce}</dd>
                  </>
                )}
                {epoch?.finalizeTx && (
                  <>
                    <dt>Added up in</dt>
                    <dd>
                      <Tx hash={epoch.finalizeTx} />
                    </dd>
                  </>
                )}
                {dispute?.onchainRequestTx && (
                  <>
                    <dt>Complaint filed in</dt>
                    <dd>
                      <Tx hash={dispute.onchainRequestTx} />
                    </dd>
                  </>
                )}
              </dl>
            </Details>
          </div>
          <div className="stack">
            <div className="card">
              <h2 className="h3">What was asked for</h2>
              <div className="mt-md">
                <Summary value={data.spec.input} />
              </div>
              <Details summary="Show raw request">
                <pre style={{ maxHeight: 420 }}>{JSON.stringify(data.spec.input, null, 2)}</pre>
              </Details>
            </div>
            <div className="card">
              <h2 className="h3">What was delivered</h2>
              <div className="mt-md">{job.result === null ? <p className="muted">Not delivered yet.</p> : <Summary value={job.result} />}</div>
              {job.result !== null && (
                <Details summary="Show raw result">
                  <pre style={{ maxHeight: 420 }}>{JSON.stringify(job.result, null, 2)}</pre>
                </Details>
              )}
            </div>
            {(data.parent || data.children.length > 0) && (
              <div className="card">
                <h2 className="h3">Related jobs</h2>
                <div className="stack stack-sm mt-md" style={{ fontSize: 15 }}>
                  {data.parent && (
                    <Link className="link" to={`/jobs/${data.parent.id}`}>
                      ↑ Part of a {serviceName(data.parent.service).toLowerCase()} job
                    </Link>
                  )}
                  {data.children.map((c) => (
                    <Link key={c.id} to={`/jobs/${c.id}`} className="spread">
                      <span className="link">
                        {serviceName(c.service)} from <AgentChip id={c.seller} link={false} />
                      </span>
                      <Money v={c.price} />
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
