import { useState } from "react";
import { Link, useParams } from "react-router";
import type { AgentSummary, DisputeView, IntentView, JobView, PositionView, RoundView, SettlementView, TransferView } from "@quorum/core";
import { API, useApi, useLive } from "../lib/api.ts";
import { ago, score, signedUsd, usd } from "../lib/format.ts";
import { Account, AgentChip, Empty, Loading, PageHead, Status, Tag, hue } from "../components/ui.tsx";

export function AgentList() {
  const live = useLive();
  const [group, setGroup] = useState<"all" | "research" | "market">("all");
  const agents = live.agents;
  const isMarket = (a: AgentSummary) => a.role === "Buyer agent" || a.role === "GPU seller";
  const shown = agents.filter((a) => group === "all" || (group === "market") === isMarket(a));
  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow="The swarm" title="Every agent is its own NEAR account" lead="Each one has its own key, collateral, balance inside the verifier and reputation. Its bids, its settlements and its verdicts are transactions and signatures under its own name.">
          {(["all", "research", "market"] as const).map((g) => (
            <button key={g} className={`btn sm${g === group ? "" : " ghost"}`} onClick={() => setGroup(g)}>
              {g}
            </button>
          ))}
        </PageHead>
        <div className="card flush">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Account</th>
                  <th>Sells</th>
                  <th className="r">Reputation</th>
                  <th className="r">Jobs sold</th>
                  <th className="r">Jobs bought</th>
                  <th className="r">Free collateral</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.agentId}>
                    <td>
                      <AgentChip id={a.agentId} agents={agents} />
                      <div className="faint" style={{ fontSize: 12, marginLeft: 26 }}>
                        {a.role}
                      </div>
                    </td>
                    <td>
                      <Account id={a.account} />
                    </td>
                    <td className="muted">{a.services.map((s) => `${s.id} ${usd(s.price, 4)}`).join(" · ") || "—"}</td>
                    <td className="r num">{score(a.reputation)}</td>
                    <td className="r num">{a.jobsSold}</td>
                    <td className="r num">{a.jobsBought}</td>
                    <td className="r num">{usd(a.collateral.headroom)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <Empty>{live.connected ? "No agents registered yet." : "Not connected to the clearing service."}</Empty>}
          </div>
        </div>
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
  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow={`Agent #${a.agentId} · ${a.role}`} title={<span className="row" style={{ gap: 16 }}><i style={{ width: 34, height: 34, borderRadius: "50%", background: hue(a.agentId), border: "1px solid rgba(243,240,232,.5)" }} />{a.name}</span>} lead={a.description}>
          <Status value={a.status} />
          {a.isValidator && <Tag>validator</Tag>}
          <a className="btn ghost sm" href={`${API}/v1/agents/${a.agentId}/export.csv`}>
            CSV
          </a>
        </PageHead>

        <div className="grid g4" style={{ marginBottom: 14 }}>
          <div className="card light stat" style={{ minHeight: 150 }}>
            <span className="label">Reputation</span>
            <div className="fig">{score(a.reputation)}</div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Sold</span>
            <div className="fig">
              {usd(a.volumeSold)}
              <small style={{ display: "inline", marginLeft: 10 }}>{a.jobsSold} jobs</small>
            </div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Bought</span>
            <div className="fig">
              {usd(a.volumeBought)}
              <small style={{ display: "inline", marginLeft: 10 }}>{a.jobsBought} jobs</small>
            </div>
          </div>
          <div className="card dots stat" style={{ minHeight: 150 }}>
            <span className="label">Collateral</span>
            <div className="fig">
              {usd(a.collateral.total)}
              <small style={{ display: "inline", marginLeft: 10 }}>{usd(a.collateral.locked)} locked</small>
            </div>
          </div>
        </div>

        <div className="grid g2" style={{ marginBottom: 14 }}>
          <div className="card">
            <h3 className="h3" style={{ marginBottom: 16 }}>
              Identity
            </h3>
            <dl className="kv">
              <dt>NEAR account</dt>
              <dd>
                <Account id={a.account} />
              </dd>
              <dt>Operator</dt>
              <dd>
                <Account id={a.operator} />
              </dd>
              <dt>Signing key</dt>
              <dd className="mono">{a.publicKey}</dd>
              <dt>Agent card</dt>
              <dd>
                <a className="link mono" href={a.cardUrl} target="_blank" rel="noreferrer">
                  {a.cardUrl.replace(/^https?:\/\//, "")}
                </a>
              </dd>
              <dt>Sells</dt>
              <dd>{a.services.length ? a.services.map((s) => `${s.name} (${usd(s.price, 4)} per ${s.unit})`).join(", ") : "nothing: this agent only buys"}</dd>
              <dt>Unsettled exposure</dt>
              <dd className="num">{usd(a.collateral.exposure, 4)}</dd>
            </dl>
          </div>
          <div className="card">
            <h3 className="h3" style={{ marginBottom: 16 }}>
              What the score is made of
            </h3>
            <dl className="kv">
              <dt>Jobs completed</dt>
              <dd className="num">{inputs.completed}</dd>
              <dt>Disputes lost</dt>
              <dd className="num">{Number(inputs.disputesLost).toFixed(2)} (fades over 20 epochs)</dd>
              <dt>Frivolous disputes</dt>
              <dd className="num">{Number(inputs.frivolousDisputes).toFixed(2)}</dd>
              <dt>Settled on time</dt>
              <dd className="num">{inputs.settledOnTime}</dd>
              <dt>Defaults</dt>
              <dd className="num">{inputs.defaults} (never fade)</dd>
              <dt>On chain</dt>
              <dd>{data.reputation.chain.score === null ? "not written yet (900 until it is)" : `${score(data.reputation.chain.score)} as of epoch ${data.reputation.chain.epoch}`}</dd>
            </dl>
            <p className="note" style={{ marginTop: 18 }}>
              The contract reads the on-chain score when it decides whether a sealed bid counts in a round with a reputation floor.
            </p>
          </div>
        </div>

        <div className="grid g2">
          <div className="card flush">
            <div className="card-head" style={{ padding: "24px 20px 0" }}>
              <h3 className="h3">Recent jobs</h3>
            </div>
            <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
              <table>
                <tbody>
                  {data.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <Link className="link" to={`/jobs/${j.id}`}>
                          {j.buyer === me ? "bought" : "sold"} {j.service}
                        </Link>
                        {j.roundId && <span className="faint"> · round #{j.roundId}</span>}
                      </td>
                      <td>
                        <AgentChip id={j.buyer === me ? j.seller : j.buyer} />
                      </td>
                      <td className="r num">{usd(j.price, 4)}</td>
                      <td>
                        <Status value={j.status} />
                      </td>
                      <td className="r faint">{ago(j.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.jobs.length === 0 && <Empty>No jobs yet.</Empty>}
            </div>
          </div>
          <div className="stack">
            <div className="card flush">
              <div className="card-head" style={{ padding: "24px 20px 0" }}>
                <h3 className="h3">Net position per epoch</h3>
              </div>
              <div className="table-wrap" style={{ maxHeight: 250, overflowY: "auto" }}>
                <table>
                  <tbody>
                    {data.positions.map((p) => (
                      <tr key={p.epoch}>
                        <td>
                          <Link className="link" to={`/epochs/${p.epoch}`}>
                            Epoch {p.epoch}
                          </Link>
                        </td>
                        <td className="r num">{signedUsd(p.net)}</td>
                        <td>
                          <Status value={p.state} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.positions.length === 0 && <Empty>Not in a netted epoch yet.</Empty>}
              </div>
            </div>
            <div className="card flush">
              <div className="card-head" style={{ padding: "24px 20px 0" }}>
                <h3 className="h3">Rounds and spending limits</h3>
              </div>
              <div className="table-wrap" style={{ maxHeight: 250, overflowY: "auto" }}>
                <table>
                  <tbody>
                    {data.rounds.slice(0, 12).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link className="link" to={`/rounds/${r.id}`}>
                            Round #{r.id}
                          </Link>
                        </td>
                        <td className="muted">{r.winner === me ? "won" : r.opener === me ? "opened" : r.bids.some((b) => b.seller === me) ? "bid" : "joined"}</td>
                        <td className="r num">{r.clearingPrice ? usd(r.clearingPrice, 4) : "—"}</td>
                      </tr>
                    ))}
                    {data.intents.slice(0, 6).map((i) => (
                      <tr key={i.id}>
                        <td colSpan={2}>{i.goal.replace("[standing] ", "")}</td>
                        <td className="r num">
                          {usd(i.spent)} of {usd(i.budget)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.rounds.length + data.intents.length === 0 && <Empty>No rounds or intents.</Empty>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
