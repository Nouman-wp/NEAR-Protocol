import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { clearRound, type JobView, type RoundView } from "@quorum/core";
import { useApi, useLive } from "../lib/api.ts";
import { usd, when } from "../lib/format.ts";
import { Account, AgentChip, Countdown, Empty, Loading, PageHead, Status, Tx } from "../components/ui.tsx";

const kindName = (r: RoundView) => (r.kind === "GroupBuy" ? "Group buy" : "Tender");
const pricingName = (r: RoundView) => (r.pricing === "SecondPrice" ? "second price" : "first price");

function deadline(r: RoundView): { label: string; to: number } | null {
  if (r.phase === "joining") return { label: "buyers can join for", to: r.joinDeadline };
  if (r.phase === "committing") return { label: "sealed bids close in", to: r.commitDeadline };
  if (r.phase === "revealing") return { label: "reveals close in", to: r.revealDeadline };
  return null;
}

export function RoundCard({ r }: { r: RoundView }) {
  const d = deadline(r);
  const hours = r.demand.reduce((n, x) => n + x.quantity, 0);
  return (
    <Link to={`/rounds/${r.id}`} className="card dots stack" style={{ gap: 18 }}>
      <div className="spread">
        <span className="label">
          Round #{r.id} · {kindName(r)}
        </span>
        <Status value={r.phase} />
      </div>
      <h3 className="h3">{r.title || r.service}</h3>
      <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
        <dt>{r.kind === "GroupBuy" ? `${r.demand.length} buyers pooling` : "Opened by"}</dt>
        <dd>{r.kind === "GroupBuy" ? `${hours} units` : <AgentChip id={r.opener} link={false} />}</dd>
        <dt>Sealed bids</dt>
        <dd>
          {r.bids.length}
          {r.status === "Open" && r.bids.some((b) => b.price !== null) ? `, ${r.bids.filter((b) => b.price !== null).length} revealed` : ""}
        </dd>
        {r.status === "Closed" ? (
          <>
            <dt>Winner</dt>
            <dd>
              <AgentChip id={r.winner} link={false} />
            </dd>
            <dt>Clearing price</dt>
            <dd className="num">{usd(r.clearingPrice, 4)}</dd>
          </>
        ) : r.status === "Void" ? (
          <>
            <dt>Void</dt>
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

/** Clearing price per round for one service: a single series, so the title names it and there is no legend. */
function PriceChart({ service }: { service: string }) {
  const { data } = useApi<{ round: number; at: number; price: string; reserve: string; quantity: number; bids: number; kind: string }[]>(`/v1/rounds/prices?service=${encodeURIComponent(service)}`, 6_000);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pts = data ?? [];
  if (pts.length < 2) return <Empty>{pts.length === 0 ? `No ${service} round has closed yet.` : "One round has closed. The chart appears after the second."}</Empty>;
  const W = 760;
  const H = 250;
  const m = { l: 62, r: 18, t: 16, b: 34 };
  const prices = pts.map((p) => Number(p.price));
  const reserve = Number(pts[pts.length - 1]!.reserve);
  const lo = Math.min(...prices) * 0.94;
  const hi = Math.max(reserve, ...prices) * 1.03;
  const x = (i: number) => m.l + (i / (pts.length - 1)) * (W - m.l - m.r);
  const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  // round tick values to a tenth of a cent so the axis reads $0.0300, not $0.030109
  const ticks = [0, 1, 2, 3].map((i) => Math.round((lo + ((hi - lo) * i) / 3) / 100) * 100);
  const h = hover === null ? null : pts[hover]!;
  return (
    <div className="chart" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Clearing price of ${service} over ${pts.length} rounds, from ${usd(pts[0]!.price, 4)} to ${usd(pts[pts.length - 1]!.price, 4)}`}
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
              {usd(Math.round(t), 4)}
            </text>
          </g>
        ))}
        <line x1={m.l} x2={W - m.r} y1={y(reserve)} y2={y(reserve)} stroke="var(--sage-light)" strokeDasharray="3 5" opacity={0.7} />
        <text className="axis" x={W - m.r} y={y(reserve) - 7} textAnchor="end">
          reserve {usd(reserve, 4)}
        </text>
        <path d={pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(p.price)).toFixed(1)}`).join("")} fill="none" stroke="var(--blush)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {pts.length <= 40 && pts.map((p, i) => <circle key={p.round} cx={x(i)} cy={y(Number(p.price))} r={hover === i ? 5.5 : 4} fill="var(--blush)" stroke="var(--panel-solid)" strokeWidth={2} />)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} stroke="rgba(243,240,232,.3)" />}
        <text className="axis" x={m.l} y={H - 10}>
          round #{pts[0]!.round}
        </text>
        <text className="axis" x={W - m.r} y={H - 10} textAnchor="end">
          round #{pts[pts.length - 1]!.round}
        </text>
      </svg>
      {h && hover !== null && (
        <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(Number(h.price)) / H) * 100}%` }}>
          <b>{usd(h.price, 4)}</b> per unit · round #{h.round}
          <br />
          {h.bids} bids · {h.quantity} units · {h.kind === "GroupBuy" ? "group buy" : "tender"}
        </div>
      )}
    </div>
  );
}

export function RoundList() {
  const live = useLive();
  const { data, error } = useApi<RoundView[]>("/v1/rounds?limit=100", 5_000);
  const [service, setService] = useState<string | null>(null);
  const rounds = useMemo(() => {
    const m = new Map((data ?? []).map((r) => [r.id, r]));
    for (const r of live.rounds.values()) m.set(r.id, r);
    return [...m.values()].sort((a, b) => b.id - a.id);
  }, [data, live.rounds]);
  if (!data) return <Loading error={error} what="rounds" />;
  const services = [...new Set(rounds.map((r) => r.service))];
  const shown = service ?? services[0] ?? null;
  const closed = rounds.filter((r) => r.status === "Closed");
  const saved = closed.reduce((s, r) => s + BigInt(r.savings ?? 0), 0n);
  const bids = rounds.reduce((n, r) => n + r.bids.length, 0);
  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow="Sealed-bid rounds" title="How the swarm finds a price" lead="A round is a reverse auction run by the contract. Sellers commit to a hidden price and reveal it only after bidding has closed, so nobody can bid against what they have seen." />
        <div className="grid g4" style={{ marginBottom: 14 }}>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Rounds closed</span>
            <div className="fig">{closed.length}</div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Sealed bids</span>
            <div className="fig">{bids}</div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Void rounds</span>
            <div className="fig">{rounds.filter((r) => r.status === "Void").length}</div>
          </div>
          <div className="card light stat" style={{ minHeight: 150 }}>
            <span className="label">Paid under the reserve</span>
            <div className="fig">{usd(saved)}</div>
          </div>
        </div>
        {shown && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h3 className="h3">Clearing price per round · {shown}</h3>
              <div className="row">
                {services.map((sv) => (
                  <button key={sv} className={`btn sm${sv === shown ? "" : " ghost"}`} onClick={() => setService(sv)}>
                    {sv}
                  </button>
                ))}
              </div>
            </div>
            <PriceChart service={shown} />
          </div>
        )}
        <div className="card flush">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>For</th>
                  <th>Opened by</th>
                  <th className="r">Buyers</th>
                  <th className="r">Bids</th>
                  <th>Winner</th>
                  <th className="r">Price / unit</th>
                  <th className="r">Reserve</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="link" to={`/rounds/${r.id}`}>
                        #{r.id} {kindName(r)}
                      </Link>
                    </td>
                    <td>{r.title || r.service}</td>
                    <td>
                      <AgentChip id={r.opener} />
                    </td>
                    <td className="r num">{r.demand.length}</td>
                    <td className="r num">{r.bids.length}</td>
                    <td>
                      <AgentChip id={r.winner} />
                    </td>
                    <td className="r num">{r.clearingPrice ? usd(r.clearingPrice, 4) : "—"}</td>
                    <td className="r num muted">{usd(r.reservePrice, 4)}</td>
                    <td>
                      <Status value={r.phase} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rounds.length === 0 && <Empty>No round has been opened yet. Run the “Group buy” scenario on the live floor.</Empty>}
          </div>
        </div>
      </div>
    </main>
  );
}

export function RoundPage() {
  const id = Number(useParams().id);
  const live = useLive();
  const { data, error } = useApi<{ round: RoundView; jobs: JobView[]; contract: string }>(`/v1/rounds/${id}`, 3_000);
  if (!data) return <Loading error={error} what={`round #${id}`} />;
  const r = live.rounds.get(id) && data.round.status === "Open" ? live.rounds.get(id)! : data.round;
  const reserve = Number(r.reservePrice);
  const d = deadline(r);
  const settled = r.status !== "Open";
  const sorted = [...r.bids].sort((a, b) => (a.price === null ? 1 : b.price === null ? -1 : Number(a.price) - Number(b.price)));
  // redo the contract's rule in the browser from the revealed bids
  const redo = settled ? clearRound(r.pricing, BigInt(r.reservePrice), 0, r.demand.map((x) => ({ buyer: x.buyer, quantity: x.quantity, maxPrice: BigInt(x.maxPrice) })), r.bids.map((b) => ({ seller: b.seller, price: b.price === null || b.invalid ? null : BigInt(b.price), reputation: 1000 }))) : null;
  const agrees = redo && (r.status === "Closed" ? redo.winner === r.winner && redo.clearingPrice === BigInt(r.clearingPrice!) : redo.status === "Void");
  return (
    <main className="page">
      <div className="wrap">
        <PageHead
          eyebrow={`Round #${r.id} · ${kindName(r)} · ${pricingName(r)}`}
          title={r.title || r.service}
          lead={
            r.kind === "GroupBuy"
              ? "Buyers pooled their demand, sellers bid one unit price for the lot, and every buyer that accepted the price pays quantity × price: its own share and nothing more."
              : "One buyer put this job out to competing sellers. The cheapest valid sealed bid wins it."
          }
        >
          <Status value={r.phase} />
        </PageHead>

        <div className="grid g4" style={{ marginBottom: 14 }}>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">{settled ? "Clearing price per unit" : (d?.label ?? "Closing")}</span>
            <div className="fig">{r.status === "Closed" ? usd(r.clearingPrice, 4) : r.status === "Void" ? "void" : <Countdown to={d?.to} done="closing" />}</div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Winner</span>
            <div className="h3">{r.winner ? <AgentChip id={r.winner} /> : settled ? (r.voidReason ?? "none") : "sealed"}</div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Units allocated</span>
            <div className="fig">{settled ? r.totalQuantity : r.demand.reduce((n, x) => n + x.quantity, 0)}</div>
          </div>
          <div className="card light stat" style={{ minHeight: 150 }}>
            <span className="label">Saved against the reserve</span>
            <div className="fig">{r.savings ? usd(r.savings, 3) : "—"}</div>
          </div>
        </div>

        <div className="grid split">
          <div className="card flush">
            <div className="card-head" style={{ padding: "24px 20px 6px" }}>
              <h3 className="h3">Bids</h3>
              <span className="label">reserve {usd(r.reservePrice, 4)} per unit</span>
            </div>
            {r.bids.length === 0 && <Empty>{settled ? "No seller bid." : "No sealed bid yet."}</Empty>}
            {sorted.map((b) => {
              const win = b.seller === r.winner;
              const cls = win ? " win" : b.invalid ? " out" : "";
              return (
                <div key={b.seller} className={`bid${cls}`}>
                  <AgentChip id={b.seller} />
                  <div className="track">
                    {b.price === null ? <div className="sealed">sealed · {b.commitment}</div> : <i style={{ width: `${Math.min(100, (Number(b.price) / reserve) * 100)}%` }} />}
                  </div>
                  <span className="num" style={{ textAlign: "right", minWidth: 108 }}>
                    {b.price === null ? (settled ? "never revealed" : "hidden") : usd(b.price, 4)}
                    {win && <small style={{ display: "block", color: "var(--blush)", fontSize: 11 }}>WINNER</small>}
                    {b.invalid && b.price !== null && <small style={{ display: "block", fontSize: 11 }}>{b.invalid}</small>}
                  </span>
                </div>
              );
            })}
            {redo && (
              <p className="note" style={{ margin: 20, borderColor: agrees ? "var(--sage)" : "var(--bad)" }}>
                {agrees
                  ? `Recomputed in your browser from the revealed bids: ${r.status === "Closed" ? `the lowest valid bid wins, and under ${pricingName(r)} rules the price is ${usd(r.clearingPrice, 4)}.` : "no valid bid, so the round is void."} This matches the contract.`
                  : "Recomputing this round from the revealed bids in your browser does not match the contract's result (a reputation floor can exclude a bid this page counts)."}
                {r.bids.some((b) => b.price !== null) && " Each revealed price was checked on chain against the commitment its seller posted before bidding closed."}
              </p>
            )}
          </div>

          <div className="stack">
            <div className="card flush">
              <div className="card-head" style={{ padding: "24px 20px 0" }}>
                <h3 className="h3">{r.kind === "GroupBuy" ? "Buyers and their shares" : "Buyer"}</h3>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Buyer</th>
                      <th className="r">Units</th>
                      <th className="r">Limit</th>
                      <th className="r">Pays</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.demand.map((x) => {
                      const a = r.allocations.find((y) => y.buyer === x.buyer);
                      return (
                        <tr key={x.buyer}>
                          <td>
                            <AgentChip id={x.buyer} />
                          </td>
                          <td className="r num">{x.quantity}</td>
                          <td className="r num muted">{usd(x.maxPrice, 4)}</td>
                          <td className="r num">{a ? a.jobId ? <Link className="link" to={`/jobs/${a.jobId}`}>{usd(a.cost, 4)}</Link> : usd(a.cost, 4) : settled ? <span className="faint">priced out</span> : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <h3 className="h3" style={{ marginBottom: 16 }}>
                On chain
              </h3>
              <dl className="kv">
                <dt>Contract</dt>
                <dd>
                  <Account id={data.contract} />
                </dd>
                <dt>Opened</dt>
                <dd>
                  {when(r.openedAt)} · <Tx hash={r.openTx} />
                </dd>
                <dt>Bidding closed</dt>
                <dd>{when(r.commitDeadline)}</dd>
                <dt>Closed</dt>
                <dd>{r.closedAt ? <>{when(r.closedAt)} · <Tx hash={r.closeTx} /></> : "—"}</dd>
                <dt>Spec hash</dt>
                <dd className="mono">{r.specHash}</dd>
                <dt>Reputation floor</dt>
                <dd>{r.minReputation ? (r.minReputation / 10).toFixed(1) : "none"}</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
