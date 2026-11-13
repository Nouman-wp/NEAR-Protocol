import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { EpochView } from "@quorum/core";
import { api, useApi, useLive } from "../lib/api.ts";
import { openDebts } from "../lib/derive.ts";
import { ago, clock, PHASE_NAMES, plural, serviceName, usd } from "../lib/format.ts";
import { Orbit } from "../components/Orbit.tsx";
import { AgentChip, Details, Empty, Go, NextStep, PageHead, Status, Tag, Tx } from "../components/ui.tsx";
import { RoundCard } from "./Rounds.tsx";

const PHASES = ["intake", "challenge", "closing", "settling", "sealed"] as const;

/** The first entry is the one demo most visitors should press. */
const SCENARIOS = [
  ["swarm-minute", "Run a 1-minute demo", "Six group orders and four research jobs in a minute, then one settle-up."],
  ["group-buy", "Buying together", "Buyers team up to buy GPU hours. Sellers bid in secret and the best bid wins."],
  ["research-brief", "Research job", "An agent asks for research. Its lead hires fact checkers and writers through auctions."],
  ["rogue-attack", "A cheater joins", "One agent bids too low and does bad work. Buyers complain, and its bids stop counting."],
  ["default-drill", "Someone doesn't pay", "One agent stops paying. When time runs out, its deposit pays what it owes."],
] as const;

const DEMO_SECONDS = 60;

function EpochClock({ e }: { e: EpochView }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const span = e.intakeEndsAt - e.startsAt;
  const done = Math.min(1, Math.max(0, (now - e.startsAt) / span));
  const left = e.intakeEndsAt - now;
  return (
    <>
      <p className="h3" aria-live="polite">
        {left > 0 ? (
          <>
            Next settle-up in <span className="num">{clock(left)}</span>
          </>
        ) : (
          "Settling up now…"
        )}
      </p>
      <div className="bar" style={{ marginTop: 14 }}>
        <i style={{ width: `${done * 100}%` }} />
      </div>
    </>
  );
}

function TryIt({ running }: { running: string | null }) {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem("quorum-admin") ?? "quorum-admin";
    } catch {
      return "quorum-admin";
    }
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [startedAt]);

  const call = async (path: string, body: object, demo = false) => {
    setBusy(true);
    try {
      localStorage.setItem("quorum-admin", token);
    } catch {
      /* private window: the key just isn't remembered */
    }
    try {
      const r = await api<{ ok?: boolean; message?: string; epoch?: number }>(path, { method: "POST", body: JSON.stringify({ ...body, token }), headers: { "x-admin-token": token } });
      const ok = r.ok !== false;
      setMsg({ ok, text: r.epoch ? `Settle-up ${r.epoch} is open. The last one is being settled now.` : ok ? "Started. Watch the tab fill up below." : (r.message ?? "That didn't start.") });
      if (ok && demo) setStartedAt(Date.now());
    } catch (err) {
      const text = (err as Error).message;
      setMsg({ ok: false, text: /token|unauthor|forbidden|401|403/i.test(text) ? "The demo key was not accepted. Open “Demo key” below and check it." : `That didn't start: ${text}` });
    } finally {
      setBusy(false);
    }
  };

  const left = startedAt ? DEMO_SECONDS - Math.floor((now - startedAt) / 1000) : 0;
  const [first, ...rest] = SCENARIOS;
  return (
    <div className="card">
      <div className="card-head">
        <h2 className="h3">Try it</h2>
        {running && <Tag kind="live">{running.replace(/-/g, " ")} running</Tag>}
      </div>
      <div className="try primary">
        <div>
          <strong>{first[1]}</strong>
          <p>{first[2]}</p>
        </div>
        <button className="btn" disabled={busy} onClick={() => call("/v1/scenario", { action: "start", scenario: first[0] }, true)}>
          {busy ? "Starting…" : "Run demo"} <Go />
        </button>
      </div>
      {startedAt && (
        <div className="running" style={{ margin: "6px 0 14px" }} aria-live="polite">
          {left > 0 ? (
            <>
              <span className="spinner" aria-hidden="true" /> Demo running · <span className="num">{clock(left * 1000)}</span> left
            </>
          ) : (
            <>
              Demo finished.{" "}
              <Link className="link" to="/epochs">
                See what happened →
              </Link>
            </>
          )}
        </div>
      )}
      <Details summary="More demos">
        {rest.map(([id, name, what]) => (
          <div key={id} className="try">
            <div>
              <strong>{name}</strong>
              <p>{what}</p>
            </div>
            <button className="btn ghost sm" disabled={busy} onClick={() => call("/v1/scenario", { action: "start", scenario: id })}>
              Run
            </button>
          </div>
        ))}
        <div className="try">
          <div>
            <strong>Settle up now</strong>
            <p>Skip the wait: close the tab now and watch it settle.</p>
          </div>
          <button className="btn ghost sm" disabled={busy} onClick={() => call("/v1/admin/close-epoch", {})}>
            Settle up
          </button>
        </div>
      </Details>
      <Details summary="Demo key">
        <label className="stack stack-sm" style={{ maxWidth: 320 }}>
          <span className="muted" style={{ fontSize: 14 }}>
            The demos need a key. It is filled in for you; on a local run it is <code>quorum-admin</code>.
          </span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Demo key" />
        </label>
      </Details>
      {msg && (
        <p className="note" role="status" style={{ marginTop: 14, borderColor: msg.ok ? "var(--sage)" : "var(--bad)" }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

export default function Floor() {
  const live = useLive();
  const s = live.stats;
  const debts = openDebts(live);
  const fleetState = useApi<{ reachable?: boolean; ready?: boolean; scenario?: { name: string } | null }>("/v1/scenario", 4_000).data;
  const cur = s ? live.epochs.get(s.currentEpoch) : undefined;
  const inFlight = [...live.epochs.values()].filter((e) => e.id !== s?.currentEpoch && e.phase !== "sealed").sort((a, b) => b.id - a.id);
  const lastSealed = [...live.epochs.values()].filter((e) => e.phase === "sealed" && e.iouCount > 0).sort((a, b) => b.id - a.id)[0];
  const rounds = [...live.rounds.values()].sort((a, b) => b.id - a.id);
  const open = rounds.filter((r) => r.status === "Open");
  const recent = rounds.filter((r) => r.status !== "Open").slice(0, 3);
  const nextRound = rounds.find((r) => r.status === "Closed");
  const phaseIndex = cur ? PHASES.indexOf(cur.phase as (typeof PHASES)[number]) : 0;
  const complaints = live.refusals.length + live.disputes.size;

  return (
    <main className="page">
      <div className="wrap">
        <PageHead title="Live" lead="This is happening on NEAR right now. Run a demo to see a full cycle in a minute.">
          {fleetState && fleetState.reachable !== false && fleetState.ready === false && <Tag kind="warn">Agents are getting ready</Tag>}
          {fleetState?.reachable === false && <Tag kind="bad">Agents offline</Tag>}
        </PageHead>

        {/* the orbit on the left; what you can do and what is happening on the right, so neither column runs long */}
        <div className="grid split balance">
          <div className="card dots flush" style={{ aspectRatio: "1 / 1" }}>
            {live.agents.length ? (
              <Orbit
                agents={live.agents}
                edges={debts.edges}
                active={debts.active}
                centre={debts.count ? { label: "On the tab this round", value: usd(debts.gross) } : { label: "Waiting for the first tab entry", value: "Press Run demo" }}
              />
            ) : (
              <Empty>{live.connected ? "No agents yet. They sign up in their first minute." : "Connecting to the live service…"}</Empty>
            )}
          </div>
          <div className="stack live-side">
            <TryIt running={fleetState?.scenario?.name ?? null} />
            <div className="card">
              {cur ? <EpochClock e={cur} /> : <p className="muted">Waiting for the settle-up clock…</p>}
              <ol className="phases" aria-label="Settle-up steps">
                {PHASES.map((p, i) => (
                  <li key={p} className={i === phaseIndex ? "now" : i < phaseIndex ? "done" : ""} aria-current={i === phaseIndex ? "step" : undefined}>
                    {PHASE_NAMES[p]}
                  </li>
                ))}
              </ol>
              {inFlight.map((e) => (
                <div key={e.id} className="spread" style={{ marginTop: 14, fontSize: 15 }}>
                  <Link className="link" to={`/epochs/${e.id}`}>
                    Settle-up {e.id}: {e.iouCount ? plural(e.iouCount, "tab entry", "tab entries") : "adding up…"}
                  </Link>
                  <Status value={e.phase} />
                </div>
              ))}
              {lastSealed && (
                <div className="spread" style={{ marginTop: 14, fontSize: 15, flexWrap: "wrap" }}>
                  <Link className="link" to={`/epochs/${lastSealed.id}`}>
                    Last settle-up: {plural(lastSealed.iouCount, "tab entry", "tab entries")} → {plural(lastSealed.settlementTransfers, "payment")}
                  </Link>
                  {lastSealed.settleTx && <Tx hash={lastSealed.settleTx} label="See on NEAR ↗" />}
                </div>
              )}
            </div>
            <div className="card flush">
              <div className="card-head inset">
                <h2 className="h3">Tab entries</h2>
                {live.ious.length > 0 && <span className="label">Newest first</span>}
              </div>
              <div className="feed" aria-live="off" style={{ maxHeight: 360 }}>
                {live.ious.length === 0 && <Empty>None yet. Run a demo to start some.</Empty>}
                {live.ious.slice(0, 60).map(({ iou, job, at }) => (
                  <Link key={iou.digest} to={`/jobs/${job.id}`} className="feed-row">
                    <span className="row" style={{ gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
                      <AgentChip id={iou.buyer} link={false} />
                      <span className="faint">owes</span>
                      <AgentChip id={iou.seller} link={false} />
                    </span>
                    <span className="num">{usd(iou.amount)}</span>
                    <small>
                      {serviceName(job.service)}
                      {job.roundId ? ` · auction #${job.roundId}` : ""}
                    </small>
                    <small style={{ textAlign: "right" }}>{ago(at)}</small>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="spread" style={{ margin: "56px 0 18px" }}>
          <h2 className="h3">{open.length ? "Auctions happening now" : "Latest auctions"}</h2>
          <Link className="link" to="/rounds">
            All auctions →
          </Link>
        </div>
        <div className="grid g3 balance">
          {(open.length ? open.slice(0, 3) : recent).map((r) => (
            <RoundCard key={r.id} r={r} />
          ))}
          {rounds.length === 0 && (
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <Empty>No auctions yet. Run a demo to start one.</Empty>
            </div>
          )}
        </div>

        <div className="card flush" style={{ marginTop: 14 }}>
          <div className="card-head inset">
            <h2 className="h3">Complaints</h2>
            <Link className="link" to="/disputes">
              All complaints →
            </Link>
          </div>
          {complaints === 0 ? (
            <Empty>No complaints since you opened this page.</Empty>
          ) : (
            <div className="feed" style={{ maxHeight: 380 }}>
              {[...live.disputes.values()]
                .slice(-8)
                .reverse()
                .map((d) => (
                  <Link key={d.id} to={`/jobs/${d.jobId}`} className="feed-row">
                    <span>
                      <AgentChip id={d.buyer} link={false} /> <span className="faint">complained about</span> <AgentChip id={d.seller} link={false} />
                    </span>
                    <Status value={d.status} />
                    <small style={{ gridColumn: "1 / -1" }}>{d.reasoning ?? d.reason}</small>
                  </Link>
                ))}
              {live.refusals.slice(0, 12).map((r, i) => (
                <div key={i} className="feed-row">
                  <span>
                    <AgentChip id={r.buyer === "?" ? null : r.buyer} link={false} /> <span className="faint">was refused</span>
                  </span>
                  <span className="num">{usd(r.amount)}</span>
                  <small style={{ gridColumn: "1 / -1" }}>{r.reason}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        {nextRound ? (
          <NextStep to={`/rounds/${nextRound.id}`} title="Look inside an auction" text={`See who bid on “${nextRound.title || serviceName(nextRound.service)}”, who won and the winning price.`} />
        ) : (
          <NextStep to="/rounds" title="Look inside an auction" text="See who bid, who won and the winning price." />
        )}
      </div>
    </main>
  );
}
