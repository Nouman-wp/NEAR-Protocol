import { Link } from "react-router";
import { BuiltOnNear, NearCost, OnNear, useNearProof } from "../components/Near.tsx";
import { NextStep, PageHead } from "../components/ui.tsx";

/**
 * A mainnet settle-up, if one has been made: set VITE_MAINNET_SETTLE_TX (and optionally
 * VITE_MAINNET_EXPLORER) at build time and the card appears. Nothing is shown otherwise.
 */
const MAINNET_TX = (import.meta.env.VITE_MAINNET_SETTLE_TX as string | undefined)?.trim() || null;
const MAINNET_EXPLORER = ((import.meta.env.VITE_MAINNET_EXPLORER as string | undefined)?.trim() || "https://nearblocks.io").replace(/\/+$/, "");

export default function NearPage() {
  const p = useNearProof();
  return (
    <main className="page">
      <div className="wrap stack stack-lg">
        <PageHead
          eyebrow="Built on NEAR"
          title="How Yuki uses NEAR"
          lead="Every step of Yuki runs on NEAR. Each row below links to a real example you can open and check."
        />

        <div className="card">
          <BuiltOnNear />
        </div>

        <div className="grid g2 balance">
          <div className="card stack stack-md">
            <h2 className="h3">What it costs on NEAR</h2>
            <p className="muted" style={{ margin: 0 }}>
              Adding up the tab is cheap because it happens once for everyone, not once per job.
            </p>
            <NearCost />
          </div>
          <div className="card stack stack-md">
            <h2 className="h3">{p.testnet ? "Running on NEAR testnet" : `Running on ${p.network}`}</h2>
            {p.testnet ? (
              <p className="muted" style={{ margin: 0 }}>
                This site runs on testnet, so no real money moves. NEAR Intents (<code>intents.near</code>) only exists on mainnet, so here the payments go through{" "}
                <strong>{p.intents?.account ?? "a stand-in contract"}</strong>: a small contract with the same <code>execute_intents</code> interface and the same signed payloads. The same code points at <code>intents.near</code> on mainnet.
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Payments go through <strong>{p.intents?.account}</strong>.
              </p>
            )}
            {MAINNET_TX ? (
              <div className="mainnet-proof">
                <strong>Also settled on NEAR mainnet</strong>
                <span className="muted">A real settle-up paid through intents.near.</span>
                <a className="on-near" href={`${MAINNET_EXPLORER}/txns/${MAINNET_TX}`} target="_blank" rel="noreferrer">
                  See the mainnet payment <span aria-hidden="true">↗</span>
                </a>
              </div>
            ) : null}
            <div className="row">
              {p.contract && <OnNear account={p.contract} label="The Yuki contract" />}
              {p.intents?.account && <OnNear account={p.intents.account} label="The payment contract" />}
            </div>
            <Link className="link" to="/developers">
              Technical details for developers →
            </Link>
          </div>
        </div>

        <NextStep to="/verify" title="Check it yourself" text="Your browser reads a settle-up straight from NEAR and redoes every number." />
      </div>
    </main>
  );
}
