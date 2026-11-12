import { Link, useParams } from "react-router";
import type { EpochView } from "@quorum/core";
import { API, useApi, useLive, type EpochDetail } from "../lib/api.ts";
import { pct, signedUsd, usd, when } from "../lib/format.ts";
import { AgentChip, Countdown, Empty, Loading, PageHead, Status, Tx } from "../components/ui.tsx";
import { Arrow } from "../components/ui.tsx";

export function EpochList() {
  const live = useLive();
  const { data, error } = useApi<EpochView[]>("/v1/epochs?limit=80", 5_000);
  if (!data) return <Loading error={error} what="epochs" />;
  const epochs = data.map((e) => live.epochs.get(e.id) ?? e);
  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow="Epochs" title="Every epoch has a receipt" lead="An epoch takes IOUs, lets buyers dispute, then nets on chain. Only the differences move, in one batch through the verifier." />
        <div className="card flush">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Epoch</th>
                  <th className="r">IOUs</th>
                  <th className="r">Gross</th>
                  <th className="r">Net</th>
                  <th className="r">Transfers</th>
                  <th className="r">Avoided</th>
                  <th>Settlement</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {epochs.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link className="link" to={`/epochs/${e.id}`}>
                        Epoch {e.id}
                      </Link>
                    </td>
                    <td className="r num">{e.iouCount}</td>
                    <td className="r num">{usd(e.grossVolume, 4)}</td>
                    <td className="r num">{usd(e.netVolume, 4)}</td>
                    <td className="r num">{e.phase === "intake" ? "—" : e.settlementTransfers}</td>
                    <td className="r num">{e.iouCount ? `${e.transfersAvoided} (${pct(e.transferReduction)})` : "—"}</td>
                    <td>
                      <Tx hash={e.settleTx} />
                    </td>
                    <td>
                      <Status value={e.phase} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}

export function EpochPage() {
  const id = Number(useParams().id);
  const live = useLive();
  const { data, error } = useApi<EpochDetail>(`/v1/epochs/${id}`, 3_000);
  if (!data) return <Loading error={error} what={`epoch ${id}`} />;
  const e = live.epochs.get(id) ?? data.epoch;
  const netted = e.phase === "settling" || e.phase === "sealed";
  const settleTxs = data.txs.filter((t) => t.kind === "settle");
  return (
    <main className="page">
      <div className="wrap">
        <PageHead
          eyebrow={`Epoch ${e.id}`}
          title={netted ? `${e.iouCount} IOUs became ${e.settlementTransfers} transfers` : `${data.ious.length} IOUs so far`}
          lead={
            netted
              ? "The contract verified every buyer's signature, recomputed each agent's position and fixed the plan below. Debtors then signed NEAR Intents transfers that match it line for line."
              : "This epoch has not been netted yet. Positions and the settlement plan appear once the contract finalises it."
          }
        >
          <Status value={e.phase} />
          {netted && (
            <Link className="btn sm" to={`/verify?epoch=${e.id}`}>
              Verify in your browser <Arrow />
            </Link>
          )}
          <a className="btn ghost sm" href={`${API}/v1/epochs/${e.id}/export.csv`}>
            CSV
          </a>
        </PageHead>

        <div className="grid g4" style={{ marginBottom: 14 }}>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Gross traded</span>
            <div className="fig">{usd(e.grossVolume)}</div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Net that had to move</span>
            <div className="fig">{netted ? usd(e.netVolume) : "—"}</div>
          </div>
          <div className="card light stat" style={{ minHeight: 150 }}>
            <span className="label">Transfers avoided</span>
            <div className="fig">
              {netted ? e.transfersAvoided : "—"}
              {netted && e.iouCount > 0 && <small style={{ display: "inline", marginLeft: 12 }}>{pct(e.transferReduction)} fewer</small>}
            </div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">{e.phase === "settling" ? "Debtors must sign within" : e.phase === "intake" ? "Intake closes in" : "Defaults"}</span>
            <div className="fig">{e.phase === "settling" ? <Countdown to={e.settleDeadline} done="deadline" /> : e.phase === "intake" ? <Countdown to={e.intakeEndsAt} done="closing" /> : e.defaults}</div>
          </div>
        </div>
        {e.error && <p className="note" style={{ borderColor: "var(--bad)", marginBottom: 14 }}>Last attempt to advance this epoch failed and is being retried: {e.error}</p>}

        {netted && (
          <div className="grid g2" style={{ marginBottom: 14 }}>
            <div className="card flush">
              <div className="card-head" style={{ padding: "24px 20px 0" }}>
                <h3 className="h3">Net positions</h3>
                <span className="label">sum to zero</span>
              </div>
              <div className="table-wrap">
                <table className="tight">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="r">Sold</th>
                      <th className="r">Bought</th>
                      <th className="r">Net</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p) => (
                      <tr key={p.agentId}>
                        <td>
                          <AgentChip id={p.agentId} />
                        </td>
                        <td className="r num muted">{usd(p.credit, 4)}</td>
                        <td className="r num muted">{usd(p.debit, 4)}</td>
                        <td className="r num">{signedUsd(p.net)}</td>
                        <td>
                          <Status value={p.state} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card flush">
              <div className="card-head" style={{ padding: "24px 20px 0" }}>
                <h3 className="h3">Settlement plan</h3>
                <span className="label">debtor → creditor, no pool</span>
              </div>
              <div className="table-wrap">
                <table className="tight">
                  <thead>
                    <tr>
                      <th>Pays</th>
                      <th>Receives</th>
                      <th className="r">Amount</th>
                      <th>State</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.transfers.map((t, i) => (
                      <tr key={i}>
                        <td>
                          <AgentChip id={t.from} />
                        </td>
                        <td>
                          <AgentChip id={t.to} />
                        </td>
                        <td className="r num">{usd(t.amount, 4)}</td>
                        <td>
                          <Status value={t.status} />
                        </td>
                        <td>
                          <Tx hash={t.tx} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.transfers.length === 0 && <Empty>Every position netted to zero: nothing had to move.</Empty>}
              </div>
              {settleTxs.length > 0 && (
                <p className="note" style={{ margin: 20 }}>
                  Executed by the verifier in {settleTxs.length} transaction{settleTxs.length === 1 ? "" : "s"}. Each one carries several debtors' signed payloads and either all of its transfers happen or none do.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="grid split">
          <div className="card flush">
            <div className="card-head" style={{ padding: "24px 20px 0" }}>
              <h3 className="h3">Signed IOUs</h3>
              <span className="label">{data.ious.length}</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: 560, overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Buyer</th>
                    <th>Seller</th>
                    <th className="r">Amount</th>
                    <th>State</th>
                    <th>Job</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ious.map((i) => (
                    <tr key={i.digest}>
                      <td>
                        <AgentChip id={i.buyer} />
                      </td>
                      <td>
                        <AgentChip id={i.seller} />
                      </td>
                      <td className="r num">{usd(i.amount, 4)}</td>
                      <td>
                        <Status value={i.status} />
                      </td>
                      <td>
                        <Link className="link mono" to={`/jobs/${i.jobId}`}>
                          {i.jobId.slice(4, 12)}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.ious.length === 0 && <Empty>No IOUs in this epoch.</Empty>}
            </div>
          </div>
          <div className="stack">
            <div className="card">
              <h3 className="h3" style={{ marginBottom: 16 }}>
                On chain
              </h3>
              <dl className="kv">
                <dt>Finalised</dt>
                <dd>
                  <Tx hash={e.finalizeTx} />
                </dd>
                <dt>IOU set</dt>
                <dd className="mono">{e.iouSetHash ?? "—"}</dd>
                <dt>Positions</dt>
                <dd className="mono">{e.positionsHash ?? "—"}</dd>
                <dt>Plan</dt>
                <dd className="mono">{e.planHash ?? "—"}</dd>
                <dt>Receipt</dt>
                <dd className="mono">{e.receiptHash ?? "—"}</dd>
                <dt>Opened</dt>
                <dd>{when(e.startsAt)}</dd>
              </dl>
              {data.txs.length > 0 && (
                <div className="stack" style={{ gap: 8, marginTop: 20 }}>
                  {data.txs.map((t) => (
                    <div key={t.hash} className="spread" style={{ fontSize: 14 }}>
                      <span className="mono muted">{t.kind}</span>
                      <Tx hash={t.hash} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {data.rounds.length > 0 && (
              <div className="card">
                <h3 className="h3" style={{ marginBottom: 14 }}>
                  Rounds that set these prices
                </h3>
                <div className="stack" style={{ gap: 10 }}>
                  {data.rounds.map((r) => (
                    <Link key={r.id} to={`/rounds/${r.id}`} className="spread" style={{ fontSize: 14 }}>
                      <span className="link">
                        #{r.id} {r.title || r.service}
                      </span>
                      <span className="num">{r.clearingPrice ? usd(r.clearingPrice, 4) : "void"}</span>
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
