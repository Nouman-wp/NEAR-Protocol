import { useState } from "react";
import { Link, useParams } from "react-router";
import type { EpochView } from "@quorum/core";
import { agentName, API, useApi, useLive, type EpochDetail } from "../lib/api.ts";
import { pct, plural, serviceName, usd, usdExact, when } from "../lib/format.ts";
import { AgentChip, Countdown, Details, Empty, Go, Hash, Loading, Money, NextStep, PageHead, Status, Tx } from "../components/ui.tsx";

const entries = (n: number) => plural(n, "tab entry", "tab entries");

export function EpochList() {
  const live = useLive();
  const { data, error } = useApi<EpochView[]>("/v1/epochs?limit=80", 5_000);
  const [showEmpty, setShowEmpty] = useState(false);
  if (!data) return <Loading error={error} what="settle-ups" />;
  const all = data.map((e) => live.epochs.get(e.id) ?? e);
  // an open settle-up is always shown, even before its first entry
  const empty = all.filter((e) => e.iouCount === 0 && e.phase === "sealed");
  const epochs = showEmpty ? all : all.filter((e) => !(e.iouCount === 0 && e.phase === "sealed"));
  const best = [...all].filter((e) => e.phase === "sealed").sort((a, b) => b.transfersAvoided - a.transfersAvoided || b.id - a.id)[0];
  const s = live.stats;
  return (
    <main className="page">
      <div className="wrap">
        <PageHead title="Settle-ups" lead="Every few minutes Yuki adds up the tab and pays everyone in one go." />
        <div className="stats" style={{ ["--n" as string]: 1 }}>
          <div className="card light stat">
            <span className="label">Payments saved so far</span>
            <div className="fig">
              {s ? s.transfersAvoided.toLocaleString("en-US") : "…"}
              {s && s.iousCleared > 0 && <small>{pct(s.transferReduction)} fewer than paying for every job</small>}
            </div>
          </div>
          {best && best.transfersAvoided > 0 ? (
            <Link className="card stat" to={`/epochs/${best.id}`}>
              <span className="label">Best: settle-up {best.id}</span>
              <div className="fig">
                {best.iouCount} → {best.settlementTransfers}
                <small>
                  {entries(best.iouCount)} became {plural(best.settlementTransfers, "payment")}
                </small>
              </div>
            </Link>
          ) : (
            <div className="card stat">
              <span className="label">Settle-ups done</span>
              <div className="fig">{s?.epochsSealed ?? "…"}</div>
            </div>
          )}
        </div>
        <div className="card flush">
          <div className="table-wrap">
            <table className="cards">
              <thead>
                <tr>
                  <th scope="col">Settle-up</th>
                  <th scope="col" className="r">
                    Entries
                  </th>
                  <th scope="col" className="r">
                    Total
                  </th>
                  <th scope="col" className="r">
                    Payments
                  </th>
                  <th scope="col" className="r">
                    Saved
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Payment</th>
                </tr>
              </thead>
              <tbody>
                {epochs.map((e) => (
                  <tr key={e.id}>
                    <td data-label="">
                      <Link className="link" to={`/epochs/${e.id}`}>
                        Settle-up {e.id}
                      </Link>
                    </td>
                    <td data-label="Entries" className="r num">
                      {e.iouCount}
                    </td>
                    <td data-label="Total" className="r">
                      <Money v={e.grossVolume} />
                    </td>
                    <td data-label="Payments" className="r num">
                      {e.phase === "intake" ? <span className="faint">Not yet</span> : e.settlementTransfers}
                    </td>
                    <td data-label="Saved" className="r num">
                      {e.phase === "intake" || !e.iouCount ? <span className="faint">–</span> : e.transfersAvoided ? `${e.transfersAvoided} (${pct(e.transferReduction)})` : "0"}
                    </td>
                    <td data-label="Status">
                      <Status value={e.phase} />
                    </td>
                    <td data-label="Payment">{e.settleTx ? <Tx hash={e.settleTx} label="See on NEAR ↗" /> : <span className="faint">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {epochs.length === 0 && <Empty>No settle-ups with entries yet. Run a demo on the Live page.</Empty>}
          </div>
          {empty.length > 0 && (
            <div style={{ padding: "14px 20px", borderTop: "1px solid var(--line)" }}>
              <button className="btn ghost sm" onClick={() => setShowEmpty(!showEmpty)}>
                {showEmpty ? "Hide empty settle-ups" : `Show empty settle-ups (${empty.length})`}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export function EpochPage() {
  const id = Number(useParams().id);
  const live = useLive();
  const { data, error } = useApi<EpochDetail>(`/v1/epochs/${id}`, 3_000);
  if (!data) return <Loading error={error} what={`settle-up ${id}`} />;
  const e = live.epochs.get(id) ?? data.epoch;
  const netted = e.phase === "settling" || e.phase === "sealed";
  const settleTxs = [...new Set(data.transfers.map((t) => t.tx).filter((t): t is string => !!t))];
  const buyers = new Set(data.ious.map((i) => i.buyer));
  const sellers = new Set(data.ious.map((i) => i.seller));
  const nothingSaved = netted && e.iouCount > 0 && e.transfersAvoided === 0;
  const lead = !netted
    ? "This settle-up is still open. Who pays whom appears once Yuki adds it up."
    : nothingSaved
      ? buyers.size === 1
        ? `Nothing to combine this time: one buyer paid ${plural(sellers.size, "different seller")}, so each payment had to go on its own.`
        : "Nothing to combine this time: every payment went between a different pair of agents."
      : "Yuki checked every signature, added up what each agent owes or is owed, and paid it all in one go.";
  return (
    <main className="page">
      <div className="wrap">
        <PageHead back={{ to: "/epochs", label: "All settle-ups" }} eyebrow={`Settle-up ${e.id}`} title={netted ? `${entries(e.iouCount)} → ${plural(e.settlementTransfers, "payment")}` : `${entries(data.ious.length)} so far`} lead={lead}>
          <Status value={e.phase} />
          {netted && (
            <Link className="btn sm" to={`/verify?epoch=${e.id}`}>
              Check it yourself <Go />
            </Link>
          )}
          <a className="btn ghost sm" href={`${API}/v1/epochs/${e.id}/export.csv`} aria-label={`Download settle-up ${e.id} as a CSV file`}>
            Download CSV ↓
          </a>
        </PageHead>

        {e.error && (
          <p className="note" style={{ borderColor: "var(--bad)", marginBottom: 14 }}>
            The last try to move this settle-up on failed and is being retried: {e.error}
          </p>
        )}

        <div className="receipt-layout">
          <Receipt e={e} detail={data} />
          <div className="stack">
            {netted ? (
              <>
                <div className="card flush">
                  <div className="card-head inset">
                    <h2 className="h3">Who paid whom</h2>
                  </div>
                  {settleTxs.length > 0 && (
                    <div className="callout">
                      <span>{settleTxs.length === 1 ? "All paid in one transaction, all or nothing:" : `Paid in ${settleTxs.length} transactions, each all or nothing:`}</span>
                      {settleTxs.map((t) => (
                        <Tx key={t} hash={t} label="See on NEAR ↗" />
                      ))}
                    </div>
                  )}
                  <div className="table-wrap">
                    <table className="tight cards">
                      <thead>
                        <tr>
                          <th scope="col">Pays</th>
                          <th scope="col">Receives</th>
                          <th scope="col" className="r">
                            Amount
                          </th>
                          <th scope="col">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.transfers.map((t, i) => (
                          <tr key={i}>
                            <td data-label="Pays">
                              <AgentChip id={t.from} />
                            </td>
                            <td data-label="Receives">
                              <AgentChip id={t.to} />
                            </td>
                            <td data-label="Amount" className="r">
                              <Money v={t.amount} />
                            </td>
                            <td data-label="Status">
                              <Status value={t.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {data.transfers.length === 0 && <Empty>Everyone came out even: nothing had to be paid.</Empty>}
                  </div>
                </div>
      <div className="card flush">
                  <div className="card-head inset">
                    <h2 className="h3">Final totals</h2>
                    <span className="label">Everyone's totals add up to zero ✓</span>
                  </div>
                  <div className="table-wrap">
                    <table className="tight cards">
                      <thead>
                        <tr>
                          <th scope="col">Agent</th>
                          <th scope="col" className="r">
                            Sold
                          </th>
                          <th scope="col" className="r">
                            Bought
                          </th>
                          <th scope="col" className="r">
                            Owes / is owed
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.positions.map((p) => {
                          const n = BigInt(p.net);
                          return (
                            <tr key={p.agentId}>
                              <td data-label="">
                                <AgentChip id={p.agentId} />
                              </td>
                              <td data-label="Sold" className="r muted">
                                <Money v={p.credit} />
                              </td>
                              <td data-label="Bought" className="r muted">
                                <Money v={p.debit} />
                              </td>
                              <td data-label="Owes / is owed" className="r">
                                {n === 0n ? (
                                  <span className="faint">Even</span>
                                ) : n > 0n ? (
                                  <span className="owed">
                                    is owed <Money v={n} />
                                  </span>
                                ) : (
                                  <span className="owes">
                                    owes <Money v={-n} />
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="card">
                <h2 className="h3">Who pays whom</h2>
                <p className="muted" style={{ marginTop: 8 }}>
                  This appears once the tab closes and Yuki adds it up.
                </p>
              </div>
            )}
          </div>
        </div>


        <div className="grid split balance">
          <div className="card flush">
            <div className="card-head inset">
              <h2 className="h3">Tab entries</h2>
              <span className="label">{data.ious.length}</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: 560, overflowY: "auto" }}>
              <table className="cards">
                <thead>
                  <tr>
                    <th scope="col">Buyer</th>
                    <th scope="col">Seller</th>
                    <th scope="col" className="r">
                      Amount
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Job</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ious.map((i) => (
                    <tr key={i.digest}>
                      <td data-label="Buyer">
                        <AgentChip id={i.buyer} />
                      </td>
                      <td data-label="Seller">
                        <AgentChip id={i.seller} />
                      </td>
                      <td data-label="Amount" className="r">
                        <Money v={i.amount} />
                      </td>
                      <td data-label="Status">
                        <Status value={i.status} />
                      </td>
                      <td data-label="Job">
                        <Link className="link" to={`/jobs/${i.jobId}`}>
                          View job →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.ious.length === 0 && <Empty>No tab entries in this settle-up.</Empty>}
            </div>
          </div>
          <div className="stack">
            {data.rounds.length > 0 && (
              <div className="card">
                <h2 className="h3">Auctions that set these prices</h2>
                <div className="stack stack-sm mt-md">
                  {data.rounds.map((r) => (
                    <div key={r.id} className="spread" style={{ fontSize: 15 }}>
                      <Link className="link" to={`/rounds/${r.id}`}>
                        #{r.id} {r.title || serviceName(r.service)}
                      </Link>
                      <span className="num">{r.clearingPrice ? usd(r.clearingPrice) : "Cancelled"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="card">
              <h2 className="h3">Opened</h2>
              <p className="muted" style={{ marginTop: 8 }}>
                {when(e.startsAt)}
              </p>
              <Details summary="Show proof on NEAR">
                <dl className="kv">
                  <dt>Added up in</dt>
                  <dd>
                    <Tx hash={e.finalizeTx} />
                  </dd>
                  <dt>Entries fingerprint</dt>
                  <dd>
                    <Hash value={e.iouSetHash} />
                  </dd>
                  <dt>Totals fingerprint</dt>
                  <dd>
                    <Hash value={e.positionsHash} />
                  </dd>
                  <dt>Who-pays-whom fingerprint</dt>
                  <dd>
                    <Hash value={e.planHash} />
                  </dd>
                  <dt>Receipt</dt>
                  <dd>
                    <Hash value={e.receiptHash} />
                  </dd>
                </dl>
                {data.txs.length > 0 && (
                  <div className="stack stack-sm mt-md">
                    {data.txs.map((t) => (
                      <div key={t.hash} className="spread" style={{ fontSize: 14 }}>
                        <span className="mono muted">{t.kind}</span>
                        <Tx hash={t.hash} />
                      </div>
                    ))}
                  </div>
                )}
                <p className="note mt-md">Technical names: a settle-up is an epoch, a tab entry is an IOU, and the payments go through NEAR Intents.</p>
              </Details>
            </div>
          </div>
        </div>

        {netted && <NextStep to={`/verify?epoch=${e.id}`} title="Check it yourself" text="Your browser reads this settle-up from NEAR and redoes every number. It takes a few seconds." />}
      </div>
    </main>
  );
}

/** The settle-up as a bar tab: every entry, a dotted line, the totals, and a stamp once it is paid. */
function Receipt({ e, detail }: { e: EpochView; detail: EpochDetail }) {
  const live = useLive();
  const name = (id: string) => agentName(live.agents, id);
  const SHOW = 8;
  const shown = detail.ious.slice(0, SHOW);
  const tx = detail.transfers.find((t) => t.tx)?.tx;
  const paid = e.phase === "sealed";
  const netted = e.phase === "settling" || e.phase === "sealed";
  return (
    <div className="receipt-wrap">
      <article className="receipt" aria-label={`Receipt for settle-up ${e.id}`}>
        <header className="receipt-head">
          <strong>YUKI</strong>
          <span>Settle-up {e.id}</span>
          <span>{when(e.startsAt)}</span>
        </header>
        <div className="receipt-rule" />
        <p className="receipt-section">The tab</p>
        {detail.ious.length === 0 ? (
          <p className="receipt-empty">Nothing on the tab yet.</p>
        ) : (
          <ul className="receipt-lines">
            {shown.map((i) => (
              <li key={i.digest}>
                <span className="who">
                  {name(i.buyer)} → {name(i.seller)}
                </span>
                <span className="dots" aria-hidden="true" />
                <span className="amt" title={usdExact(i.amount)}>
                  {usd(i.amount)}
                </span>
              </li>
            ))}
            {detail.ious.length > SHOW && <li className="more">+ {entries(detail.ious.length - SHOW)} more</li>}
          </ul>
        )}
        <div className="receipt-rule" />
        <dl className="receipt-totals">
          <dt>Tab entries</dt>
          <dd>{e.iouCount || detail.ious.length}</dd>
          <dt>Total on the tab</dt>
          <dd>{usd(e.grossVolume)}</dd>
          {netted && (
            <>
              <dt>Payments needed</dt>
              <dd>{e.settlementTransfers}</dd>
              <dt>Payments saved</dt>
              <dd>
                {e.transfersAvoided}
                {e.transfersAvoided > 0 && ` (${pct(e.transferReduction)})`}
              </dd>
            </>
          )}
        </dl>
        <div className="receipt-rule double" />
        <div className="receipt-grand">
          <span>{netted ? "Total paid" : "Still open"}</span>
          <strong>{netted ? usd(e.netVolume) : e.phase === "intake" ? <Countdown to={e.intakeEndsAt} done="closing" /> : "…"}</strong>
        </div>
        {e.defaults > 0 && <p className="receipt-note">{plural(e.defaults, "agent")} didn't pay in time. Their deposit paid instead.</p>}
        {netted && <p className="receipt-note">Everyone's totals add up to zero ✓</p>}
        <div className={`stamp${paid ? "" : " pending"}`} aria-hidden="true">
          {paid ? (
            <>
              Paid
              <small>on NEAR</small>
            </>
          ) : netted ? (
            <>
              Paying
              <small>now</small>
            </>
          ) : (
            <>
              Tab
              <small>open</small>
            </>
          )}
        </div>
        <footer className="receipt-foot">
          {paid && tx ? <Tx hash={tx} label="See the payment on NEAR ↗" /> : <span>{paid ? "Paid on NEAR" : netted ? "Payments going through…" : "Settles when the timer runs out"}</span>}
          {netted && (
            <Link className="link" to={`/verify?epoch=${e.id}`}>
              Check it yourself →
            </Link>
          )}
        </footer>
      </article>
    </div>
  );
}
