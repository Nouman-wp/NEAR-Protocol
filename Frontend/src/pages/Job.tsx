import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { DisputeView, EpochView, IouView, JobSpec, JobView, PositionView, QuorumDomain, RoundView, SettlementView, TransferView } from "@quorum/core";
import { useApi } from "../lib/api.ts";
import { verifyJob, type Check } from "../lib/verify.ts";
import { signedUsd, usd, when } from "../lib/format.ts";
import { AgentChip, Loading, PageHead, Status, Tx } from "../components/ui.tsx";

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
      <h4>{title}</h4>
      <div className="muted stack" style={{ gap: 6, fontSize: 14.5 }}>
        {children}
        {check && (
          <span style={{ color: check.ok ? "var(--good)" : "var(--bad)" }}>
            {check.ok ? "Verified in your browser. " : "Does not verify. "}
            {check.detail}
          </span>
        )}
      </div>
    </div>
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
  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow={`Job ${job.id.slice(4, 14)} · ${job.service}`} title={<>{usd(job.price, 4)} for one {job.service} job</>} lead="The chain of evidence behind one payment, from the round that set its price to the transfer that settled it. Each signature below is checked again in your browser.">
          <Status value={job.status} />
        </PageHead>
        <div className="grid split">
          <div className="card">
            <div className="chain">
              {data.round && (
                <Step title={`Price set by round #${data.round.id}`}>
                  <span>
                    {data.round.bids.length} sealed bid{data.round.bids.length === 1 ? "" : "s"}; <AgentChip id={data.round.winner} /> won at {usd(data.round.clearingPrice, 4)} per unit. <Link className="link" to={`/rounds/${data.round.id}`}>See the bids</Link>
                  </span>
                </Step>
              )}
              <Step title="Job specified" check={checks?.spec}>
                <span>
                  <AgentChip id={job.buyer} /> asked <AgentChip id={job.seller} /> for <code>{job.service}</code> on {when(job.createdAt)}.
                </span>
                <span className="mono">{job.jobHash}</span>
              </Step>
              <Step title="Seller's binding quote" check={checks?.quote}>
                <span>
                  {usd(data.quote.message.price, 4)}, valid until {when(Number(data.quote.message.expiry) * 1000)}.
                </span>
              </Step>
              <Step title="Buyer's IOU" check={checks?.iou} pending={!iou}>
                {iou ? (
                  <>
                    <span>
                      A promise of {usd(iou.amount, 4)} in epoch {iou.epoch}, nonce {iou.nonce}. <Status value={iou.status} />
                    </span>
                    <span className="mono">{iou.digest}</span>
                  </>
                ) : (
                  <span>No IOU was accepted for this job.</span>
                )}
              </Step>
              <Step title="Delivery" check={checks?.delivery} pending={!data.delivery}>
                {data.delivery ? <span>Delivered {when(data.delivery.deliveredAt)}. The buyer could dispute until {when(data.delivery.challengeEndsAt)}.</span> : <span>Not delivered. An undelivered job is voided when its epoch closes and is never paid for.</span>}
              </Step>
              {dispute && (
                <Step title={`Dispute ${dispute.status}`}>
                  <span>Buyer's reason: {dispute.reason}</span>
                  {dispute.reasoning && (
                    <span>
                      <AgentChip id={dispute.validator} /> ruled: {dispute.reasoning}
                    </span>
                  )}
                  <span>
                    On chain: request <Tx hash={dispute.onchainRequestTx} />
                  </span>
                </Step>
              )}
              <Step title={epoch ? `Netted in epoch ${epoch.id}` : "Netting"} pending={!sealed && epoch?.phase !== "settling"}>
                {epoch && iou?.status === "netted" ? (
                  <>
                    <span>
                      One of {epoch.iouCount} IOUs the contract verified and netted into {epoch.settlementTransfers} transfers. <Link className="link" to={`/epochs/${epoch.id}`}>Epoch receipt</Link> · finalised in <Tx hash={epoch.finalizeTx} />
                    </span>
                    <span>
                      Buyer's net for the epoch: {data.positions.buyer ? signedUsd(data.positions.buyer.net) : "—"}. Seller's: {data.positions.seller ? signedUsd(data.positions.seller.net) : "—"}.
                    </span>
                  </>
                ) : (
                  <span>{iou?.status === "voided" ? "Voided: this IOU was never netted and nobody paid for it." : `Waiting for epoch ${job.epoch} to close.`}</span>
                )}
              </Step>
              <Step title="Settled through the verifier" pending={!sealed}>
                {data.buyerSettlement ? (
                  <span>
                    The buyer's whole net debt of {usd(data.buyerSettlement.amount, 4)} for the epoch: <Status value={data.buyerSettlement.status} /> <Tx hash={data.buyerSettlement.settleTx} />
                  </span>
                ) : (
                  <span>{sealed ? "The buyer was not a net debtor in this epoch: what it sold covered what it bought, so it sent nothing." : "Not settled yet."}</span>
                )}
                {data.sellerReceipts.map((t, i) => (
                  <span key={i}>
                    Seller received {usd(t.amount, 4)} from <AgentChip id={t.from} /> · <Tx hash={t.tx} />
                  </span>
                ))}
              </Step>
            </div>
          </div>
          <div className="stack">
            <div className="card">
              <h3 className="h3" style={{ marginBottom: 14 }}>
                Request
              </h3>
              <pre>{JSON.stringify(data.spec.input, null, 2)}</pre>
            </div>
            <div className="card">
              <h3 className="h3" style={{ marginBottom: 14 }}>
                Result
              </h3>
              <pre style={{ maxHeight: 420 }}>{job.result === null ? "not delivered" : JSON.stringify(job.result, null, 2)}</pre>
            </div>
            {(data.parent || data.children.length > 0) && (
              <div className="card">
                <h3 className="h3" style={{ marginBottom: 14 }}>
                  Jobs this one caused
                </h3>
                <div className="stack" style={{ gap: 10, fontSize: 14 }}>
                  {data.parent && (
                    <Link className="link" to={`/jobs/${data.parent.id}`}>
                      ↑ part of a {data.parent.service} job
                    </Link>
                  )}
                  {data.children.map((c) => (
                    <Link key={c.id} to={`/jobs/${c.id}`} className="spread">
                      <span className="link">
                        {c.service} from <AgentChip id={c.seller} link={false} />
                      </span>
                      <span className="num">{usd(c.price, 4)}</span>
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
