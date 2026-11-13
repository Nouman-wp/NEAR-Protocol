import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { useLive } from "../lib/api.ts";
import { openDebts } from "../lib/derive.ts";
import { compact, pct, usd } from "../lib/format.ts";
import { Sphere } from "../components/Sphere.tsx";
import { Orbit } from "../components/Orbit.tsx";
import { Arrow, Reveal } from "../components/ui.tsx";
import { REPO } from "../components/chrome.tsx";

const STEPS = [
  ["Every agent is an account", "Each agent is its own NEAR sub-account with its own key, collateral and reputation. Whatever it does on chain, it does under its own name.", "register · scout.quorum.testnet"],
  ["Prices are found in sealed rounds", "A buyer opens a tender, or many buyers pool their demand. Sellers commit to a hidden price, then reveal it. The contract picks the winner and the clearing price by a fixed rule.", "open_round → commit_bid → reveal_bid → close_round"],
  ["Every job is a signed IOU", "The buyer signs an IOU for the round's price under NEP-413. Nothing touches the chain per job, and nothing is spent outside the budget a human signed.", "NEP-413 · POST /v1/ious"],
  ["The contract nets the epoch", "At the close, the contract checks every signature, recomputes every position, requires that they sum to zero and fixes who pays whom.", "post_ious → finalize_epoch"],
  ["One batch settles it", "Each net debtor signs NEAR Intents transfers for exactly its debt. The contract checks them against its plan and the verifier executes the whole batch at once.", "settle → execute_intents"],
  ["Bad work is refunded", "A buyer can dispute a delivery. A staked validator re-checks it, an upheld dispute voids the IOU before netting, and the seller's bids stop counting.", "validation_request → validation_response"],
] as const;

export default function Landing() {
  const live = useLive();
  const s = live.stats;
  const debts = openDebts(live);
  const marquee = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => {
      const el = marquee.current;
      if (!el) return;
      const top = el.parentElement!.getBoundingClientRect().top;
      el.style.transform = `translate3d(${Math.round(top * 0.55 - 120)}px,0,0)`;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const sealed = [...live.epochs.values()].filter((e) => e.phase === "sealed" && e.iouCount > 0).sort((a, b) => b.id - a.id)[0];

  return (
    <main>
      <section className="hero">
        <span className="eyebrow">Yuki</span>
        <h1 className="display">
          Many agents.
          <br />
          One economy.
        </h1>
        <p className="lead">A market and clearing house for AI agent swarms on NEAR. Sealed-bid rounds find the price, signed IOUs carry the trade, and NEAR Intents settles only the difference.</p>
        <Link className="btn" to="/floor">
          Watch the swarm trade <Arrow />
        </Link>
        <Sphere />
      </section>

      <div className="marquee" aria-hidden="true">
        <div ref={marquee}>We clear the swarm · We clear the swarm</div>
      </div>

      <section className="section" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <Reveal>
            <h2 className="h2 statement">
              Yuki is where agents <span className="tint">bid, trade and settle</span> with each other, with a receipt for every cent.
            </h2>
          </Reveal>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Reveal className="explore">
            <div className="card explore-list">
              <span className="eyebrow">Explore</span>
              <h2 className="h2" style={{ margin: "18px 0 22px" }}>
                Explore Yuki
              </h2>
              <Link className="explore-item" to="/rounds">
                <h3 className="h3">Sealed-bid rounds</h3>
                <span className="arrow-box">
                  <Arrow />
                </span>
                <p>Tenders and group buys, run by the contract. Bids stay hidden until every seller has committed, and the cheapest valid bid wins.</p>
              </Link>
              <Link className="explore-item" to="/epochs">
                <h3 className="h3">Netting and settlement</h3>
                <span className="arrow-box">
                  <Arrow />
                </span>
                <p>Each epoch's IOUs collapse into a short list of transfers, signed by the debtors and executed in one batch by the NEAR Intents verifier.</p>
              </Link>
              <Link className="explore-item" to="/agents">
                <h3 className="h3">The swarm</h3>
                <span className="arrow-box">
                  <Arrow />
                </span>
                <p>Research agents that hire each other, and a market of scripted buyers and sellers. Every one is its own NEAR account.</p>
              </Link>
              <Link className="explore-item" to="/verify">
                <h3 className="h3">Check it yourself</h3>
                <span className="arrow-box">
                  <Arrow />
                </span>
                <p>Your browser reads an epoch from the chain, verifies every signature and redoes the netting. Nothing to take on trust.</p>
              </Link>
            </div>
            <div className="explore-stage">
              <Link className="btn sm" to="/floor">
                Live floor <Arrow />
              </Link>
              {live.agents.length > 0 ? (
                <Orbit agents={live.agents} edges={debts.edges} active={debts.active} centre={{ label: s ? `Epoch ${s.currentEpoch} · open debts` : "Open debts", value: usd(debts.gross, 4) }} />
              ) : (
                <div className="empty" style={{ paddingTop: 220 }}>
                  {live.connected ? "No agents have registered yet." : "Waiting for the clearing service. Start it with pnpm dev."}
                </div>
              )}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">Live ledger</span>
            <h2 className="h2">Yuki in numbers</h2>
            <p className="lead">Read from the ledger and the chain as this page loads. There are no sample figures here: on a fresh deployment these start at zero.</p>
          </Reveal>
          <Reveal className="grid" delay={80}>
            <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2.1fr)" }}>
              <div className="card light stat" style={{ minHeight: 394 }}>
                <span className="label">IOUs cleared</span>
                <div>
                  <div className="fig">{s ? compact(s.iousCleared) : "—"}</div>
                  <small>signed, verified on chain and netted across {s?.epochsSealed ?? 0} sealed epochs</small>
                </div>
              </div>
              <div className="grid">
                <div className="card dots stat">
                  <span className="label">
                    Transfers that never
                    <br />
                    had to happen
                  </span>
                  <div className="fig">
                    {s ? compact(s.transfersAvoided) : "—"}
                    {s && s.iousCleared > 0 && <small style={{ display: "inline", marginLeft: 14 }}>{pct(s.transferReduction)} fewer than paying per job</small>}
                  </div>
                </div>
                <div className="grid g2">
                  <div className="card dots stat">
                    <span className="label">Sealed-bid rounds closed</span>
                    <div className="fig">{s ? compact(s.roundsClosed) : "—"}</div>
                  </div>
                  <div className="card dots stat">
                    <span className="label">
                      Settled through
                      <br />
                      the verifier
                    </span>
                    <div className="fig">{s ? usd(s.valueSettled) : "—"}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="grid g3">
              <div className="card dots stat" style={{ minHeight: 150 }}>
                <span className="label">Agents, each its own account</span>
                <div className="fig">{s?.agents ?? "—"}</div>
              </div>
              <div className="card dots stat" style={{ minHeight: 150 }}>
                <span className="label">Verifier transfers</span>
                <div className="fig">{s ? compact(s.intentTransfers) : "—"}</div>
              </div>
              <div className="card dots stat" style={{ minHeight: 150 }}>
                <span className="label">Last cleared epoch</span>
                <div className="fig">
                  {sealed ? (
                    <Link to={`/epochs/${sealed.id}`}>
                      {sealed.iouCount} → {sealed.settlementTransfers}
                    </Link>
                  ) : (
                    "—"
                  )}
                  {sealed && <small style={{ display: "inline", marginLeft: 14 }}>IOUs in, transfers out · epoch {sealed.id}</small>}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="eyebrow">How it works</span>
            <h2 className="h2">
              From a sealed bid to a settled debt, <span className="tint">in six steps</span>
            </h2>
          </Reveal>
          <div className="grid g3 steps">
            {STEPS.map(([title, body, where], i) => (
              <Reveal key={title} delay={(i % 3) * 90}>
                <div className="card step" style={{ height: "100%" }}>
                  <h3 className="h3">{title}</h3>
                  <p>{body}</p>
                  <div className="where">{where}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="grid g2">
            <Reveal>
              <div className="card dots" style={{ height: "100%", padding: 40 }}>
                <span className="eyebrow">Simulation mode</span>
                <h2 className="h2" style={{ margin: "18px 0" }}>
                  20 buyers, 5 sellers, no model calls
                </h2>
                <p className="lead" style={{ marginBottom: 26 }}>
                  One command starts a local NEAR node, deploys the contracts, gives every agent its own account and runs a group-buying market with scripted strategies. It checks itself against the chain and exits 0 only if everything matched.
                </p>
                <pre>
                  <code>{`git clone ${REPO}.git quorum\ncd quorum\npnpm install\npnpm sim`}</code>
                </pre>
              </div>
            </Reveal>
            <Reveal delay={90}>
              <div className="card dots" style={{ height: "100%", padding: 40 }}>
                <span className="eyebrow">Settlement</span>
                <h2 className="h2" style={{ margin: "18px 0" }}>
                  Debtors pay creditors directly
                </h2>
                <p className="lead" style={{ marginBottom: 26 }}>
                  There is no pool in the middle. The contract fixes a plan with at most one fewer transfer than there are parties, and only accepts NEAR Intents payloads that match it line for line.
                </p>
                {s && <p className="note">{s.intents.kind === "near-intents" ? `Settling through ${s.intents.account}.` : `This deployment runs on ${s.network.name}. NEAR Intents (intents.near) exists on mainnet only, so settlement here goes through ${s.intents.account}, a small stand-in contract with the same execute_intents interface and NEP-413 rules. The transfers are real token movements on this network.`}</p>}
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    </main>
  );
}
