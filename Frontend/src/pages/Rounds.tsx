import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { clearRound, type JobView, type RoundView } from "@quorum/core";
import { agentName, useApi, useLive } from "../lib/api.ts";
import { pct, plural, serviceName, usd, when } from "../lib/format.ts";
import { OnNear } from "../components/Near.tsx";
import { Account, AgentChip, Countdown, Details, Empty, Hash, Loading, Money, NextStep, PageHead, Status, Tx } from "../components/ui.tsx";

const kindName = (r: RoundView) => (r.kind === "GroupBuy" ? "Buying together" : "Job request");

function deadline(r: RoundView): { label: string; to: number } | null {
  if (r.phase === "joining") return { label: "Buyers can join for", to: r.joinDeadline };
  if (r.phase === "committing") return { label: "Bidding closes in", to: r.commitDeadline };
  if (r.phase === "revealing") return { label: "Bids open in", to: r.revealDeadline };
  return null;
}

const titleOf = (r: RoundView) => r.title || serviceName(r.service);

export function RoundCard({ r }: { r: RoundView }) {
  const d = deadline(r);
  const units = r.demand.reduce((n, x) => n + x.quantity, 0);
  return (
    <Link to={`/rounds/${r.id}`} className="card stack stack-md">
      <div className="spread">
        <span className="label">
          Auction #{r.id} · {kindName(r)}
        </span>
        <Status value={r.phase} />
      </div>
      <h3 className="h3">{titleOf(r)}</h3>
      <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
        <dt>{r.kind === "GroupBuy" ? "Buyers" : "Asked by"}</dt>
        <dd>{r.kind === "GroupBuy" ? `${r.demand.length} buying ${units} together` : <AgentChip id={r.opener} link={false} />}</dd>
        <dt>Bids</dt>
        <dd>{r.bids.length}</dd>
        {r.status === "Closed" ? (
          <>
            <dt>Winner</dt>
            <dd>
              <AgentChip id={r.winner} link={false} />
            </dd>
            <dt>Winning price</dt>
            <dd className="num">{usd(r.clearingPrice)}</dd>
          </>
        ) : r.status === "Void" ? (
          <>
            <dt>Cancelled</dt>
            <dd>{r.voidReason}</dd>
          </>
        ) : (
          d && (
            <>
              <dt>{d.label}</dt>
              <dd>
                <Countdown to={d.to} done="closing" />
              </dd>
            </>
          )
        )}
      </dl>
    </Link>
  );
}

/** Winning price per auction for one service: a single series, so the title names it and there is no legend. */
function PriceChart({ service }: { service: string }) {
  const { data } = useApi<{ round: number; at: number; price: string; reserve: string; quantity: number; bids: number; kind: string }[]>(`/v1/rounds/prices?service=${encodeURIComponent(service)}`, 6_000);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pts = data ?? [];
  if (!data) return <Empty>Loading prices…</Empty>;
  if (pts.length < 2) return <Empty>{pts.length === 0 ? `No ${serviceName(service).toLowerCase()} auction has finished yet.` : `Only one ${serviceName(service).toLowerCase()} auction so far. The chart starts after the second.`}</Empty>;
  const W = 760;
  const H = 250;
  const m = { l: 70, r: 18, t: 16, b: 34 };
  const prices = pts.map((p) => Number(p.price));
  const reserve = Number(pts[pts.length - 1]!.reserve);
  const lo = Math.min(...prices) * 0.94;
  const hi = Math.max(reserve, ...prices) * 1.03;
  const x = (i: number) => m.l + (i / (pts.length - 1)) * (W - m.l - m.r);
  const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const ticks = [0, 1, 2, 3].map((i) => Math.round(lo + ((hi - lo) * i) / 3));
  const h = hover === null ? null : pts[hover]!;
  return (
    <div className="chart" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Winning price of ${serviceName(service)} over ${pts.length} auctions, from ${usd(pts[0]!.price)} to ${usd(pts[pts.length - 1]!.price)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - b.left) / b.width) * W;
          setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (pts.length - 1)))));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={m.l - 10} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {usd(t)}
            </text>
          </g>
        ))}
        <line x1={m.l} x2={W - m.r} y1={y(reserve)} y2={y(reserve)} stroke="var(--sage-light)" strokeDasharray="3 5" opacity={0.7} />
        <text className="axis" x={W - m.r} y={y(reserve) - 7} textAnchor="end">
          top price {usd(reserve)}
        </text>
        <path d={pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(p.price)).toFixed(1)}`).join("")} fill="none" stroke="var(--blush)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {pts.length <= 40 && pts.map((p, i) => <circle key={p.round} cx={x(i)} cy={y(Number(p.price))} r={hover === i ? 5.5 : 4} fill="var(--blush)" stroke="var(--panel-solid)" strokeWidth={2} />)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} style={{ stroke: "rgba(var(--fg), 0.3)" }} />}
        <text className="axis" x={m.l} y={H - 10}>
          auction #{pts[0]!.round}
        </text>
        <text className="axis" x={W - m.r} y={H - 10} textAnchor="end">
          auction #{pts[pts.length - 1]!.round}
        </text>
      </svg>
      {h && hover !== null && (
        <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(Number(h.price)) / H) * 100}%` }}>
          <b>{usd(h.price)}</b> · auction #{h.round}
          <br />
          {plural(h.bids, "bid")} · {h.kind === "GroupBuy" ? "buying together" : "job request"}
        </div>
      )}
    </div>
  );
}

const PAGE = 20;

export function RoundList() {
  const live = useLive();
  const { data, error } = useApi<RoundView[]>("/v1/rounds?limit=100", 5_000);
  const [service, setService] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const rounds = useMemo(() => {
    const m = new Map((data ?? []).map((r) => [r.id, r]));
    for (const r of live.rounds.values()) m.set(r.id, r);
    return [...m.values()].sort((a, b) => b.id - a.id);
  }, [data, live.rounds]);
  if (!data) return <Loading error={error} what="auctions" />;
  // services ordered by how many auctions finished, so the chart opens on one with a real history
  const counts = new Map<string, number>();
  for (const r of rounds) if (r.status === "Closed") counts.set(r.service, (counts.get(r.service) ?? 0) + 1);
  const services = [...new Set(rounds.map((r) => r.service))].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const shown = service ?? services[0] ?? null;
  const closed = rounds.filter((r) => r.status === "Closed");
  const saved = closed.reduce((s, r) => s + BigInt(r.savings ?? 0), 0n);
  const bids = rounds.reduce((n, r) => n + r.bids.length, 0);
  const latest = closed[0];
  return (
    <main className="page">
      <div className="wrap">
        <PageHead title="Auctions" lead="Sellers bid in secret. Nobody sees other bids until bidding ends, so nobody can copy a price." />
        <div className="stats" style={{ ["--n" as string]: 2 }}>
          <div className="card light stat">
            <span className="label">Buyers paid less than their top price by</span>
            <div className="fig">
              <Money v={saved} />
            </div>
          </div>
          <div className="card stat">
            <span className="label">Auctions finished</span>
            <div className="fig">{closed.length}</div>
          </div>
          <div className="card stat">
            <span className="label">Bids placed</span>
            <div className="fig">{bids}</div>
          </div>
        </div>
        {shown && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h2 className="h3">Winning price over time</h2>
              <label className="field">
                Service
                <select value={shown} onChange={(e) => setService(e.target.value)}>
                  {services.map((sv) => (
                    <option key={sv} value={sv}>
                      {serviceName(sv)} ({plural(counts.get(sv) ?? 0, "auction")})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <PriceChart service={shown} />
          </div>
        )}
        <div className="card flush">
          <div className="table-wrap">
            <table className="cards">
              <thead>
                <tr>
                  <th scope="col">Auction</th>
                  <th scope="col">What</th>
                  <th scope="col" className="r">
                    Bids
                  </th>
                  <th scope="col">Winner</th>
                  <th scope="col" className="r">
                    Winning price
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rounds.slice(0, limit).map((r) => (
                  <tr key={r.id}>
                    <td data-label="">
                      <Link className="link" to={`/rounds/${r.id}`}>
                        #{r.id} · {kindName(r)}
                      </Link>
                    </td>
                    <td data-label="What">{titleOf(r)}</td>
                    <td data-label="Bids" className="r num">
                      {r.bids.length}
                    </td>
                    <td data-label="Winner">{r.winner ? <AgentChip id={r.winner} /> : <span className="faint">{r.status === "Open" ? "Bidding…" : "None"}</span>}</td>
                    <td data-label="Winning price" className="r">
                      {r.clearingPrice ? <Money v={r.clearingPrice} /> : <span className="faint">Not yet</span>}
                    </td>
                    <td data-label="Status">
                      <Status value={r.phase} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rounds.length === 0 && <Empty>No auctions yet. Run a demo on the Live page to start one.</Empty>}
          </div>
          {rounds.length > limit && (
            <div style={{ padding: "14px 20px", borderTop: "1px solid var(--line)" }}>
              <button className="btn ghost sm" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, rounds.length - limit)} more
              </button>
            </div>
          )}
        </div>
        {latest && <NextStep to={`/rounds/${latest.id}`} title="Look inside an auction" text={`See every bid on “${titleOf(latest)}”, who won and why.`} />}
      </div>
    </main>
  );
}

export function RoundPage() {
  const id = Number(useParams().id);
  const live = useLive();
  const { data, error } = useApi<{ round: RoundView; jobs: JobView[]; contract: string }>(`/v1/rounds/${id}`, 3_000);
  if (!data) return <Loading error={error} what={`auction #${id}`} />;
  const r = live.rounds.get(id) && data.round.status === "Open" ? live.rounds.get(id)! : data.round;
  const reserve = Number(r.reservePrice);
  const d = deadline(r);
  const settled = r.status !== "Open";
  const sorted = [...r.bids].sort((a, b) => (a.price === null ? 1 : b.price === null ? -1 : Number(a.price) - Number(b.price)));
  // redo the contract's rule in the browser from the opened bids
  const redo = settled ? clearRound(r.pricing, BigInt(r.reservePrice), 0, r.demand.map((x) => ({ buyer: x.buyer, quantity: x.quantity, maxPrice: BigInt(x.maxPrice) })), r.bids.map((b) => ({ seller: b.seller, price: b.price === null || b.invalid ? null : BigInt(b.price), reputation: 1000 }))) : null;
  const agrees = redo && (r.status === "Closed" ? redo.winner === r.winner && redo.clearingPrice === BigInt(r.clearingPrice!) : redo.status === "Void");
  const valid = sorted.filter((b) => b.price !== null && !b.invalid);
  const lowest = valid[0];
  const under = r.clearingPrice && reserve > 0 ? 1 - Number(r.clearingPrice) / reserve : 0;
  const epochOfJobs = data.jobs.find((j) => j.epoch)?.epoch;
  const groupBuy = r.kind === "GroupBuy";
  return (
    <main className="page">
      <div className="wrap">
        <PageHead
          back={{ to: "/rounds", label: "All auctions" }}
          eyebrow={`Auction #${r.id} · ${kindName(r)}`}
          title={titleOf(r)}
          lead={groupBuy ? "Several buyers teamed up. Sellers bid one price per unit, and each buyer pays only for its own share." : "One buyer asked sellers to bid for this job. The lowest bid wins."}
        >
          <Status value={r.phase} />
          <OnNear tx={r.closeTx ?? r.openTx} label={r.closeTx ? "Closed on NEAR" : "Opened on NEAR"} />
        </PageHead>

        <div className="stats" style={{ ["--n" as string]: groupBuy ? 2 : 1 }}>
          <div className="card light stat">
            <span className="label">{settled ? "Winning price" : (d?.label ?? "Closing")}</span>
            <div className="fig">
              {r.status === "Closed" ? <Money v={r.clearingPrice} /> : r.status === "Void" ? "Cancelled" : <Countdown to={d?.to} done="closing" />}
              {r.status === "Closed" && under > 0 && <small>{pct(under)} under the top price ({usd(r.reservePrice)})</small>}
            </div>
          </div>
          <div className="card stat">
            <span className="label">Winner</span>
            <div className="h3">{r.winner ? <AgentChip id={r.winner} /> : settled ? (r.voidReason ?? "Nobody") : "Bids still hidden"}</div>
          </div>
          {groupBuy && (
            <div className="card stat">
              <span className="label">Amount bought</span>
              <div className="fig">{settled ? r.totalQuantity : r.demand.reduce((n, x) => n + x.quantity, 0)}</div>
            </div>
          )}
        </div>

        <div className="grid split balance">
          <div className="stack">
            <div className="card flush">
              <div className="card-head inset">
                <h2 className="h3">{plural(r.bids.length, "bid")}</h2>
                <span className="label">Lower is better · top price {usd(r.reservePrice)}</span>
              </div>
              {r.bids.length === 0 && <Empty>{settled ? "No seller bid." : "No bids yet."}</Empty>}
              {sorted.map((b) => {
                const win = b.seller === r.winner;
                const cls = win ? " win" : b.invalid ? " out" : "";
                return (
                  <div key={b.seller} className={`bid${cls}`}>
                    <AgentChip id={b.seller} />
                    <div className="track">
                      {b.price === null ? <div className="sealed">{settled ? "never opened" : "locked in, hidden"}</div> : <i style={{ width: `${Math.min(100, (Number(b.price) / reserve) * 100)}%` }} />}
                    </div>
                    <span className="num" style={{ textAlign: "right", minWidth: 108 }}>
                      {b.price === null ? (settled ? "Never opened" : "Hidden") : <Money v={b.price} />}
                      {win && <small style={{ display: "block", color: "var(--blush)", fontSize: 13 }}>Winner</small>}
                      {b.invalid && b.price !== null && <small style={{ display: "block", fontSize: 13 }}>Not counted: {b.invalid}</small>}
                    </span>
                  </div>
                );
              })}
              {r.status === "Closed" && lowest && (
                <p className="note" style={{ margin: 20 }}>
                  {r.pricing === "SecondPrice" && valid.length > 1 ? (
                    <>
                      {agentName(live.agents, r.winner)} bid the lowest ({usd(lowest.price)}) and is paid the next-lowest bid ({usd(r.clearingPrice)}). This rewards honest bidding: nobody gains by bidding above their real price.
                    </>
                  ) : (
                    <>{agentName(live.agents, r.winner)} bid the lowest and is paid what it bid.</>
                  )}
                  {redo && (agrees ? " Your browser worked this out again from the opened bids, and it matches." : " Your browser worked this out again and got a different answer: a minimum trust score may have ruled a bid out.")}
                </p>
              )}
            </div>

          </div>

          <div className="stack">
            <div className="card">
              <h2 className="h3">Timeline</h2>
              <dl className="kv mt-md">
                <dt>Opened</dt>
                <dd>{when(r.openedAt)}</dd>
                <dt>Bidding closed</dt>
                <dd>{when(r.commitDeadline)}</dd>
                <dt>Finished</dt>
                <dd>{r.closedAt ? when(r.closedAt) : "Not yet"}</dd>
              </dl>
              <Details>
                <dl className="kv">
                  <dt>Contract</dt>
                  <dd>
                    <Account id={data.contract} />
                  </dd>
                  <dt>Open transaction</dt>
                  <dd>
                    <Tx hash={r.openTx} />
                  </dd>
                  <dt>Close transaction</dt>
                  <dd>
                    <Tx hash={r.closeTx} />
                  </dd>
                  <dt>Job description hash</dt>
                  <dd>
                    <Hash value={r.specHash} />
                  </dd>
                  {r.minReputation > 0 && (
                    <>
                      <dt>Minimum trust score</dt>
                      <dd>{Math.round(r.minReputation / 10)}/100</dd>
                    </>
                  )}
                  <dt>Pricing rule</dt>
                  <dd>{r.pricing === "SecondPrice" ? "Second price (winner is paid the runner-up's bid)" : "First price (winner is paid its own bid)"}</dd>
                </dl>
                <p className="note" style={{ marginTop: 14 }}>
                  Every opened bid was checked on NEAR against the sealed bid its seller locked in before bidding closed.
                </p>
              </Details>
            </div>
            <div className="card flush">
              <div className="card-head inset">
                <h2 className="h3">{groupBuy ? "Buyers and their shares" : "Buyer"}</h2>
              </div>
              <div className="table-wrap">
                <table className="cards">
                  <thead>
                    <tr>
                      <th scope="col">Buyer</th>
                      <th scope="col" className="r">
                        Amount
                      </th>
                      <th scope="col" className="r">
                        Top price
                      </th>
                      <th scope="col" className="r">
                        Pays
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.demand.map((x) => {
                      const a = r.allocations.find((y) => y.buyer === x.buyer);
                      return (
                        <tr key={x.buyer}>
                          <td data-label="">
                            <AgentChip id={x.buyer} />
                          </td>
                          <td data-label="Amount" className="r num">
                            {x.quantity}
                          </td>
                          <td data-label="Top price" className="r muted">
                            <Money v={x.maxPrice} />
                          </td>
                          <td data-label="Pays" className="r">
                            {a ? (
                              a.jobId ? (
                                <Link className="link" to={`/jobs/${a.jobId}`}>
                                  <Money v={a.cost} /> · job →
                                </Link>
                              ) : (
                                <Money v={a.cost} />
                              )
                            ) : settled ? (
                              <span className="faint">Priced out</span>
                            ) : (
                              <span className="faint">Not yet</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {epochOfJobs ? (
          <NextStep to={`/epochs/${epochOfJobs}`} title="See it settled" text={`This auction's payment went on the tab and was settled in settle-up ${epochOfJobs}.`} />
        ) : (
          <NextStep to="/epochs" title="See how the tab is settled" text="Every few minutes Yuki adds up the tab and pays everyone in one go." />
        )}
      </div>
    </main>
  );
}
