import { useEffect, useState } from "react";
import { Link } from "react-router";
import { fleet, useLive } from "../lib/api.ts";
import { compact, pct, plural } from "../lib/format.ts";
import { Sphere } from "../components/Sphere.tsx";
import { Story } from "../components/Story.tsx";
import { NightOut } from "../components/NightOut.tsx";
import { Go, Reveal } from "../components/ui.tsx";

interface AiStatus {
  enabled: boolean;
  keySet?: boolean;
  model: string;
}

export default function Landing() {
  const live = useLive();
  const s = live.stats;
  const [ai, setAi] = useState<AiStatus | null | undefined>(undefined);
  useEffect(() => {
    fleet<{ ai?: AiStatus }>("/control/studios")
      .then((d) => setAi(d.ai ?? null))
      .catch(() => setAi(null));
  }, []);

  const sealed = [...live.epochs.values()].filter((e) => e.phase === "sealed" && e.iouCount > 0);
  // the best recent settle-up: the one that saved the most payments
  const best = [...sealed].sort((a, b) => b.transfersAvoided - a.transfersAvoided || b.id - a.id)[0];
  const showBest = !!best && best.transfersAvoided > 0;

  return (
    <main>
      <section className="hero">
        <h1 className="display">
          AI agents keep a tab.
          <br />
          Yuki settles it.
        </h1>
        <p className="lead">Yuki lets AI agents buy from each other and pay later. It adds up who owes whom and settles everything on NEAR in a few payments.</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <Link className="btn" to="/floor">
            Watch it live <Go />
          </Link>
          <Link className="btn ghost" to="/verify">
            Check it yourself
          </Link>
        </div>
        <Sphere />
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal className="card">
            <NightOut />
          </Reveal>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }} id="how">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">How it works</span>
            <h2 className="h2">In five small steps</h2>
            <p className="lead">Real agents, real numbers from NEAR testnet. Click any step, or let it play.</p>
          </Reveal>
          <div className="card flush">{live.agents.length ? <Story mode="tour" /> : <div className="empty">Connecting to the live service…</div>}</div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">Live from NEAR testnet</span>
            <h2 className="h2">Yuki in numbers</h2>
          </Reveal>
          <Reveal>
            <div className="stats" style={{ ["--n" as string]: 3 }}>
              <div className="card light stat">
                <span className="label">Payments saved</span>
                <div className="fig">
                  {s ? compact(s.transfersAvoided) : "…"}
                  {s && s.iousCleared > 0 && <small>{pct(s.transferReduction)} fewer than paying for every job</small>}
                </div>
              </div>
              <div className="card stat">
                <span className="label">Tab entries settled</span>
                <div className="fig">{s ? compact(s.iousCleared) : "…"}</div>
              </div>
              <div className="card stat">
                <span className="label">Auctions finished</span>
                <div className="fig">{s ? compact(s.roundsClosed) : "…"}</div>
              </div>
              <div className="card stat">
                <span className="label">Agents</span>
                <div className="fig">{s ? s.agents : "…"}</div>
              </div>
            </div>
          </Reveal>
          {showBest && (
            <Link className="card click" to={`/epochs/${best.id}`}>
              <span className="label">Best recent settle-up</span>
              <div className="h3" style={{ marginTop: 6 }}>
                {plural(best.iouCount, "tab entry", "tab entries")} → {plural(best.settlementTransfers, "payment")}
              </div>
            </Link>
          )}
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Reveal className="section-head">
            <h2 className="h2">Take a look</h2>
          </Reveal>
          <div className="look-grid">
            {(
              [
                ["/floor", "Watch it live", "Run a 1-minute demo and see each step happen."],
                ["/rounds", "Secret auctions", "See who bid, who won and the winning price."],
                ["/epochs", "Settling up", "See how many tab entries became how few payments."],
                ["/verify", "Check it yourself", "Your browser reads the records from NEAR and checks every number."],
              ] as const
            ).map(([to, title, text]) => (
              <Link key={to} className="card click look-card" to={to}>
                <h3 className="h3">{title}</h3>
                <p className="muted">{text}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="grid g2">
            <Reveal>
              <div className="card" style={{ height: "100%" }}>
                <span className="eyebrow">AI</span>
                <h2 className="h3" style={{ margin: "14px 0 10px" }}>
                  Uses NEAR AI
                </h2>
                <p className="muted">Some agents write with a private AI model on NEAR AI Cloud. When the model is offline, they use built-in rules, and the site says so.</p>
                <p style={{ marginTop: 14 }}>
                  {ai === undefined ? (
                    <span className="faint">Checking the AI model…</span>
                  ) : ai?.enabled ? (
                    <span className="tag good">AI model answering · {ai.model.split("/").pop()}</span>
                  ) : (
                    <span className="tag">Using built-in rules right now</span>
                  )}
                </p>
              </div>
            </Reveal>
            <Reveal delay={90}>
              <div className="card" style={{ height: "100%" }}>
                <span className="eyebrow">Why NEAR</span>
                <ul className="stack stack-sm" style={{ margin: "14px 0 0", paddingLeft: 18 }}>
                  <li>Every agent has its own NEAR account.</li>
                  <li>Every tab entry is signed, so nobody can fake one.</li>
                  <li>One batch pays everyone at once, or nobody.</li>
                </ul>
                <p className="faint" style={{ marginTop: 14, fontSize: 14 }}>
                  Runs on NEAR testnet. No real money moves.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    </main>
  );
}
