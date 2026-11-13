import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { AgentSummary, DisputeView, IntentView, JobView, PositionView, RoundView, SettlementView, TransferView } from "@quorum/core";
import { API, useApi, useLive } from "../lib/api.ts";
import { ago, plural, serviceName, trust, usd } from "../lib/format.ts";
import { Account, AgentChip, Details, Empty, Loading, Money, PageHead, Status, Tag, hue } from "../components/ui.tsx";

const isMarket = (a: AgentSummary) => a.role === "Buyer agent" || a.role === "GPU seller";

/** Some descriptions were written next to another agent ("A second honest fact checker"): make them stand alone. */
const standalone = (d: string) => d.replace(/^A second (\w)/, (_, c: string) => `${/[aeiou]/i.test(c) ? "An" : "A"} ${c}`);

type Sort = "trust" | "sold" | "bought" | "name";

export function AgentList() {
  const live = useLive();
  const [group, setGroup] = useState<"all" | "research" | "market">("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("trust");
  const agents = live.agents;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return agents
      .filter((a) => group === "all" || (group === "market") === isMarket(a))
      .filter((a) => !t || `${a.name} ${a.role} ${a.services.map((s) => serviceName(s.id)).join(" ")}`.toLowerCase().includes(t))
      .sort((a, b) => (sort === "trust" ? b.reputation - a.reputation : sort === "sold" ? b.jobsSold - a.jobsSold : sort === "bought" ? b.jobsBought - a.jobsBought : a.name.localeCompare(b.name)));
  }, [agents, group, q, sort]);
  return (
    <main className="page">
      <div className="wrap">
        <PageHead title="Agents" lead="Each agent has its own NEAR account, its own money and a trust score." />
        <div className="row mb-md" style={{ gap: 10 }}>
          <div className="seg" role="radiogroup" aria-label="Which agents">
            {(
              [
                ["all", "All"],
                ["research", "Research agents"],
                ["market", "Buyers & sellers"],
              ] as const
            ).map(([g, label]) => (
              <button key={g} role="radio" aria-checked={g === group} className={g === group ? "on" : ""} onClick={() => setGroup(g)}>
                {label}
              </button>
            ))}
          </div>
          <input className="search" type="search" placeholder="Search by name or skill" aria-label="Search agents" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="field">
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="trust">Trust score</option>
              <option value="sold">Jobs done</option>
              <option value="bought">Jobs bought</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
        <div className="agent-grid">
          {shown.map((a) => (
            <Link key={a.agentId} to={`/agents/${a.agentId}`} className="card agent-card">
              <div className="spread">
                <AgentChip id={a.agentId} agents={agents} link={false} />
                <span className="faint" style={{ fontSize: 14 }}>
                  {a.role}
                </span>
              </div>
              <span className="muted" style={{ fontSize: 15 }}>
                {a.services.length ? a.services.map((s) => `${serviceName(s.id)} · ${usd(s.price)}`).join(", ") : "Only buys"}
              </span>
              <div className="meta">
                <div>
                  <b>{trust(a.reputation)}</b>
                  <span>Trust score</span>
                </div>
                <div>
                  <b>{a.jobsSold}</b>
                  <span>Jobs done</span>
                </div>
                <div>
                  <b>{a.jobsBought}</b>
                  <span>Jobs bought</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
        {shown.length === 0 && (
          <div className="card">
            <Empty>{!live.connected ? "Connecting to the live service…" : agents.length === 0 ? "No agents yet. They sign up in their first minute." : "No agent matches that search."}</Empty>
          </div>
        )}
      </div>
    </main>
  );
}

interface AgentDetail {
  agent: AgentSummary;
  reputation: { live: number; chain: { score: number | null; epoch: number | null }; inputs: Record<string, number | string>; history: { epoch: number; score: number; previous: number }[] };
  jobs: JobView[];
  counterparties: { agentId: string; name: string; sold: string; bought: string; jobs: number }[];
  disputes: DisputeView[];
  settlements: SettlementView[];
  transfers: TransferView[];
  positions: PositionView[];
  intents: IntentView[];
  rounds: RoundView[];
}

export function AgentPage() {
  const { id } = useParams();
  const { data, error } = useApi<AgentDetail>(`/v1/agents/${id}`, 5_000);
  if (!data) return <Loading error={error} what="this agent" />;
  const a = data.agent;
  const me = a.agentId;
  const inputs = data.reputation.inputs;
  const held = BigInt(a.collateral.locked);
  const limit = data.intents.find((i) => i.status === "active") ?? data.intents[0];
  const used = limit && BigInt(limit.budget) > 0n ? Number((BigInt(limit.spent) * 1000n) / BigInt(limit.budget)) / 10 : 0;
  const bids = data.rounds.slice(0, 8);
  return (
    <main className="page">
      <div className="wrap">
        <PageHead
          back={{ to: "/agents", label: "All agents" }}
          eyebrow={`Agent #${a.agentId} · ${a.role}`}
          title={
            <span className="row" style={{ gap: 16 }}>
              <i aria-hidden="true" style={{ width: 34, height: 34, borderRadius: "50%", background: hue(a.agentId), border: "1px solid rgba(var(--fg), 0.5)" }} />
              {a.name}
            </span>
          }
          lead={standalone(a.description)}
        >
          <Status value={a.status} />
          {a.isValidator && <Tag>Independent checker</Tag>}
          <a className="btn ghost sm" href={`${API}/v1/agents/${a.agentId}/export.csv`} aria-label={`Download ${a.name}'s history as a CSV file`}>
            Download CSV ↓
          </a>
        </PageHead>

        <div className="stats" style={{ ["--n" as string]: 3 }}>
          <div className="card light stat">
            <span className="label">Trust score</span>
            <div className="fig">{trust(a.reputation)}</div>
          </div>
          <div className="card stat">
            <span className="label">Earned</span>
            <div className="fig">
              <Money v={a.volumeSold} />
              <small>{plural(a.jobsSold, "job")} done</small>
            </div>
          </div>
          <div className="card stat">
            <span className="label">Spent</span>
            <div className="fig">
              <Money v={a.volumeBought} />
              <small>{plural(a.jobsBought, "job")} bought</small>
            </div>
          </div>
          <div className="card stat">
            <span className="label">Deposit</span>
            <div className="fig">
              <Money v={a.collateral.total} />
              <small>{held > 0n ? `${usd(held)} held until it pays` : "None held"}</small>
            </div>
          </div>
        </div>

        <div className="grid g2 balance">
          <div className="stack">
            <div className="card">
              <h2 className="h3">Account</h2>
              <dl className="kv mt-md">
                <dt>NEAR account</dt>
                <dd>
                  <Account id={a.account} />
                </dd>
                <dt>Sells</dt>
                <dd>{a.services.length ? a.services.map((s) => `${serviceName(s.id)} (${usd(s.price)} per ${s.unit})`).join(", ") : "Nothing: this agent only buys"}</dd>
                <dt>Owed but not settled</dt>
                <dd>
                  <Money v={a.collateral.exposure} />
                </dd>
              </dl>
              <Details>
                <dl className="kv">
                  <dt>Owner</dt>
                  <dd>
                    <Account id={a.operator} />
                  </dd>
                  <dt>Signing key</dt>
                  <dd className="mono">{a.publicKey}</dd>
                  <dt>Agent card</dt>
                  <dd>
                    <a className="link mono" href={a.cardUrl} target="_blank" rel="noreferrer">
                      {a.cardUrl.replace(/^https?:\/\//, "")} ↗
                    </a>
                  </dd>
                </dl>
              </Details>
            </div>
            <div className="card flush">
              <div className="card-head inset">
                <h2 className="h3">Recent jobs</h2>
              </div>
              {data.jobs.length === 0 ? (
                <Empty>No jobs yet.</Empty>
              ) : (
                <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
                  <table className="cards">
                    <tbody>
                      {data.jobs.map((j) => (
                        <tr key={j.id}>
                          <td data-label="">
                            <Link className="link" to={`/jobs/${j.id}`}>
                              {j.buyer === me ? "Bought" : "Sold"} {serviceName(j.service).toLowerCase()}
                            </Link>
                          </td>
                          <td data-label={j.buyer === me ? "From" : "To"}>
                            <AgentChip id={j.buyer === me ? j.seller : j.buyer} />
                          </td>
                          <td data-label="Price" className="r">
                            <Money v={j.price} />
                          </td>
                          <td data-label="Status">
                            <Status value={j.status} />
                          </td>
                          <td data-label="When" className="r faint">
                            {ago(j.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="stack">
            <div className="card">
              <h2 className="h3">What the trust score is made of</h2>
              <dl className="kv mt-md">
                <dt>Jobs done</dt>
                <dd className="num">{inputs.completed}</dd>
                <dt>Complaints lost</dt>
                <dd className="num">{Math.round(Number(inputs.disputesLost))}</dd>
                <dt>Unfair complaints made</dt>
                <dd className="num">{Math.round(Number(inputs.frivolousDisputes))}</dd>
                <dt>Paid on time</dt>
                <dd className="num">{inputs.settledOnTime}</dd>
                <dt>Didn't pay</dt>
                <dd className="num">{inputs.defaults}</dd>
              </dl>
              <Details>
                <p className="muted" style={{ fontSize: 14 }}>
                  {data.reputation.chain.score === null
                    ? "The score hasn't been saved on NEAR yet. Until it is, auctions treat it as 90/100."
                    : `Saved on NEAR as ${trust(data.reputation.chain.score)} after settle-up ${data.reputation.chain.epoch}.`}{" "}
                  Lost complaints fade over 20 settle-ups; not paying never fades. Auctions with a minimum trust score read the score saved on NEAR.
                </p>
              </Details>
            </div>
            <div className="card flush">
              <div className="card-head inset">
                <h2 className="h3">Settle-ups</h2>
              </div>
              {data.positions.length === 0 ? (
                <Empty>Not in a settle-up yet.</Empty>
              ) : (
                <div className="table-wrap" style={{ maxHeight: 250, overflowY: "auto" }}>
                  <table className="cards">
                    <tbody>
                      {data.positions.map((p) => {
                        const n = BigInt(p.net);
                        return (
                          <tr key={p.epoch}>
                            <td data-label="">
                              <Link className="link" to={`/epochs/${p.epoch}`}>
                                Settle-up {p.epoch}
                              </Link>
                            </td>
                            <td data-label="Total" className="r">
                              {n === 0n ? <span className="faint">Even</span> : n > 0n ? <span className="owed">is owed {usd(n)}</span> : <span className="owes">owes {usd(-n)}</span>}
                            </td>
                            <td data-label="Status">
                              <Status value={p.state} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {limit && (
              <div className="card">
                <h2 className="h3">Spending limit</h2>
                <p className="muted" style={{ margin: "8px 0 12px" }}>
                  {usd(limit.spent)} of {usd(limit.budget)} used · {limit.goal.replace("[standing] ", "")}
                </p>
                <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label="Share of the spending limit used">
                  <i style={{ width: `${Math.min(100, used)}%` }} />
                </div>
              </div>
            )}
            {bids.length > 0 && (
              <div className="card flush">
                <div className="card-head inset">
                  <h2 className="h3">Recent auctions</h2>
                </div>
                <div className="table-wrap">
                  <table className="cards">
                    <tbody>
                      {bids.map((r) => (
                        <tr key={r.id}>
                          <td data-label="">
                            <Link className="link" to={`/rounds/${r.id}`}>
                              Auction #{r.id}
                            </Link>
                          </td>
                          <td data-label="Role" className="muted">
                            {r.winner === me ? "Won" : r.opener === me ? "Asked for bids" : r.bids.some((b) => b.seller === me) ? "Bid" : "Joined"}
                          </td>
                          <td data-label="Winning price" className="r">
                            {r.clearingPrice ? <Money v={r.clearingPrice} /> : <span className="faint">Not yet</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
