import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { EpochView } from "@quorum/core";
import { api, useApi, useLive } from "../lib/api.ts";
import { openDebts } from "../lib/derive.ts";
import { ago, usd } from "../lib/format.ts";
import { Orbit } from "../components/Orbit.tsx";
import { AgentChip, Countdown, Empty, PageHead, Status, Tag, Tx } from "../components/ui.tsx";
import { RoundCard } from "./Rounds.tsx";

const PHASES = ["intake", "challenge", "closing", "settling", "sealed"] as const;

const SCENARIOS = [
  ["group-buy", "Group buy", "A buyer opens a round, others join, sellers bid sealed, the contract picks the winner."],
  ["swarm-minute", "Swarm minute", "Six group buys and four research briefs in a minute, then one settlement batch."],
  ["research-brief", "Research brief", "The operator signs an intent; the orchestrator tenders the fact checks and hires the rest."],
  ["rogue-attack", "Rogue attack", "Rogue bids below everyone's cost and cuts quality. Disputes follow, then its bids stop counting."],
  ["default-drill", "Default drill", "The orchestrator stops signing settlements. After the deadline its collateral pays its creditors."],
] as const;

function EpochClock({ e }: { e: EpochView }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const span = e.intakeEndsAt - e.startsAt;
  const done = Math.min(1, Math.max(0, (now - e.startsAt) / span));
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <span className="label">Epoch {e.id} takes IOUs for</span>
        <span className="h3 num">
          <Countdown to={e.intakeEndsAt} done="closing" />
        </span>
      </div>
      <div className="bar">
        <i style={{ width: `${done * 100}%` }} />
      </div>
    </>
  );
}

function Scenarios() {
  const [token, setToken] = useState(() => localStorage.getItem("quorum-admin") ?? "quorum-admin");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const call = async (path: string, body: object) => {
    setBusy(true);
    localStorage.setItem("quorum-admin", token);
    try {
      const r = await api<{ ok?: boolean; message?: string; epoch?: number }>(path, { method: "POST", body: JSON.stringify({ ...body, token }), headers: { "x-admin-token": token } });
      setMsg({ ok: r.ok !== false, text: r.message ?? (r.epoch ? `Epoch ${r.epoch} is now open; the previous one is closing.` : "Done.") });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="h3">Scenario runner</h3>
        <input aria-label="Admin token" type="password" value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 170 }} placeholder="admin token" />
      </div>
      <div className="stack">
        {SCENARIOS.map(([id, name, what]) => (
          <div key={id} className="spread">
            <div style={{ minWidth: 0 }}>
              <div>{name}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {what}
              </div>
            </div>
            <button className="btn ghost sm" disabled={busy} onClick={() => call("/v1/scenario", { action: "start", scenario: id })}>
              Run
            </button>
          </div>
        ))}
        <div className="spread" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Skip the wait: close this epoch's intake now and watch it net and settle.
          </div>
          <button className="btn sm" disabled={busy} onClick={() => call("/v1/admin/close-epoch", {})}>
            Close epoch now
          </button>
        </div>
        {msg && <p className="note" style={{ borderColor: msg.ok ? "var(--sage)" : "var(--bad)" }}>{msg.text}</p>}
      </div>
    </div>
  );
}

export default function Floor() {
  const live = useLive();
  const s = live.stats;
  const debts = openDebts(live);
  const fleet = useApi<{ reachable?: boolean; ready?: boolean; scenario?: { name: string } | null }>("/v1/scenario", 4_000).data;
  const cur = s ? live.epochs.get(s.currentEpoch) : undefined;
  const inFlight = [...live.epochs.values()].filter((e) => e.id !== s?.currentEpoch && e.phase !== "sealed").sort((a, b) => b.id - a.id);
  const lastSealed = [...live.epochs.values()].filter((e) => e.phase === "sealed" && e.iouCount > 0).sort((a, b) => b.id - a.id)[0];
  const rounds = [...live.rounds.values()].sort((a, b) => b.id - a.id);
  const open = rounds.filter((r) => r.status === "Open");
  const recent = rounds.filter((r) => r.status !== "Open").slice(0, 3);

  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow="Live floor" title="The swarm, as it trades" lead="Every chord is money one agent owes another in the open epoch. When the epoch closes, the contract nets them and the chords collapse into a few transfers.">
          {fleet?.scenario && <Tag kind="live">{fleet.scenario.name.replace(/-/g, " ")} running</Tag>}
          {fleet && fleet.reachable !== false && fleet.ready === false && <Tag kind="warn">swarm is funding its accounts</Tag>}
          {fleet?.reachable === false && <Tag kind="bad">swarm offline</Tag>}
        </PageHead>

        <div className="grid split">
          <div className="card dots flush" style={{ aspectRatio: "1 / 0.92" }}>
            {live.agents.length ? (
              <Orbit agents={live.agents} edges={debts.edges} active={debts.active} centre={{ label: debts.count ? `${debts.count} IOUs this epoch` : "Last trades", value: usd(debts.gross, 4) }} />
            ) : (
              <Empty>{live.connected ? "No agents have registered yet. The swarm registers its accounts in its first minute." : "Not connected to the clearing service."}</Empty>
            )}
          </div>
          <div className="stack">
            <div className="card">
              {cur ? <EpochClock e={cur} /> : <Empty>Waiting for the epoch clock.</Empty>}
              <div className="phases">
                {PHASES.map((p) => (
                  <div key={p} className={p === "intake" ? "now" : ""}>
                    {p}
                  </div>
                ))}
              </div>
              {inFlight.map((e) => (
                <Link key={e.id} to={`/epochs/${e.id}`} className="spread" style={{ marginTop: 14, fontSize: 14 }}>
                  <span>
                    Epoch {e.id}: {e.iouCount || "…"} IOUs
                  </span>
                  <Status value={e.phase} />
                </Link>
              ))}
              {lastSealed && (
                <Link to={`/epochs/${lastSealed.id}`} className="spread" style={{ marginTop: 14, fontSize: 14 }}>
                  <span>
                    Epoch {lastSealed.id}: {lastSealed.iouCount} IOUs became {lastSealed.settlementTransfers} transfers
                  </span>
                  <Tx hash={lastSealed.settleTx} />
                </Link>
              )}
            </div>
            <div className="card flush">
              <div className="card-head" style={{ padding: "22px 20px 0" }}>
                <h3 className="h3">Signed IOUs</h3>
                <span className="label">{live.ious.length ? "newest first" : ""}</span>
              </div>
              <div className="feed">
                {live.ious.length === 0 && <Empty>No IOUs yet. Run a scenario below, or wait for the background traffic.</Empty>}
                {live.ious.slice(0, 60).map(({ iou, job, at }) => (
                  <Link key={iou.digest} to={`/jobs/${job.id}`} className="feed-row">
                    <span className="row" style={{ gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
                      <AgentChip id={iou.buyer} link={false} />
                      <span className="faint">owes</span>
                      <AgentChip id={iou.seller} link={false} />
                    </span>
                    <span className="num">{usd(iou.amount, 4)}</span>
                    <small>
                      {job.service}
                      {job.roundId ? ` · round #${job.roundId}` : ""}
                    </small>
                    <small style={{ textAlign: "right" }}>{ago(at)}</small>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="spread" style={{ margin: "56px 0 20px" }}>
          <h2 className="h3">{open.length ? "Rounds in progress" : "Latest rounds"}</h2>
          <Link className="link label" to="/rounds">
            All rounds
          </Link>
        </div>
        <div className="grid g3">
          {(open.length ? open.slice(0, 3) : recent).map((r) => (
            <RoundCard key={r.id} r={r} />
          ))}
          {rounds.length === 0 && (
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <Empty>No round has been opened yet.</Empty>
            </div>
          )}
        </div>

        <div className="grid g2" style={{ marginTop: 56 }}>
          <Scenarios />
          <div className="card flush">
            <div className="card-head" style={{ padding: "22px 20px 0" }}>
              <h3 className="h3">Refusals and disputes</h3>
              <Link className="link label" to="/disputes">
                All disputes
              </Link>
            </div>
            <div className="feed" style={{ maxHeight: 380 }}>
              {live.refusals.length + live.disputes.size === 0 && <Empty>Nothing refused or disputed since this page opened.</Empty>}
              {[...live.disputes.values()].slice(-8).reverse().map((d) => (
                <Link key={d.id} to={`/jobs/${d.jobId}`} className="feed-row">
                  <span>
                    <AgentChip id={d.buyer} link={false} /> <span className="faint">disputes</span> <AgentChip id={d.seller} link={false} />
                  </span>
                  <Status value={d.status} />
                  <small style={{ gridColumn: "1 / -1" }}>{d.reasoning ?? d.reason}</small>
                </Link>
              ))}
              {live.refusals.slice(0, 12).map((r, i) => (
                <div key={i} className="feed-row">
                  <span>
                    <AgentChip id={r.buyer === "?" ? null : r.buyer} link={false} /> <span className="faint">refused</span>
                  </span>
                  <span className="num">{usd(r.amount, 4)}</span>
                  <small style={{ gridColumn: "1 / -1" }}>{r.reason}</small>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
