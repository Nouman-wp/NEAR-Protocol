import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { fleet, useApi, useLive, type EpochDetail } from "../lib/api.ts";
import { explorerAccount, explorerTx, plural } from "../lib/format.ts";

/** A small, generic NEAR glyph (a letter in a rounded square), used on the proof chips. */
export const NearGlyph = () => (
  <svg className="near-glyph" viewBox="0 0 16 16" aria-hidden="true">
    <rect width="16" height="16" rx="4" />
    <path d="M4.6 11.6V4.4h1.2l4.2 5.1V4.4h1.4v7.2h-1.2L6 6.5v5.1Z" />
  </svg>
);

/**
 * "On NEAR ↗": the proof that a moment happened on NEAR. Links a transaction or an account on
 * the explorer. On a local sandbox (no explorer) it shows the id, without a link.
 */
export function OnNear({ tx, account, label = "On NEAR" }: { tx?: string | null; account?: string | null; label?: ReactNode }) {
  const explorer = useLive().stats?.network.explorer ?? null;
  const url = tx ? explorerTx(explorer, tx) : account ? explorerAccount(explorer, account) : null;
  const title = tx ? `NEAR transaction ${tx}` : account ? `NEAR account ${account}` : undefined;
  if (!tx && !account) return null;
  const body = (
    <>
      <NearGlyph />
      <span>{label}</span>
    </>
  );
  return url ? (
    <a className="on-near" href={url} target="_blank" rel="noreferrer" title={title}>
      {body}
      <span aria-hidden="true">↗</span>
    </a>
  ) : (
    <span className="on-near" title={title}>
      {body}
    </span>
  );
}

/** A NEAR account name, readable, linked to the explorer. */
export function NearAccount({ id, link = true }: { id: string | null | undefined; link?: boolean }) {
  const explorer = useLive().stats?.network.explorer ?? null;
  if (!id) return null;
  const url = link ? explorerAccount(explorer, id) : null;
  return url ? (
    <a className="near-account" href={url} target="_blank" rel="noreferrer" title="This agent's own NEAR account">
      <NearGlyph />
      <span>{id}</span>
    </a>
  ) : (
    <span className="near-account">
      <NearGlyph />
      <span>{id}</span>
    </span>
  );
}

/** NEAR's base gas price: 100 million yoctoNEAR per unit of gas, so 1 TGas = 0.0001 NEAR. */
const NEAR_PER_GAS = 1e-16;

interface AiStatus {
  enabled: boolean;
  model: string;
}

/** Real examples, from the live data, of each way Yuki uses NEAR. */
export function useNearProof() {
  const live = useLive();
  const s = live.stats;
  const agent = [...live.agents].sort((a, b) => b.jobsSold - a.jobsSold)[0];
  const round = [...live.rounds.values()].filter((r) => r.status === "Closed" && r.closeTx).sort((a, b) => b.id - a.id)[0];
  const sealed = [...live.epochs.values()].filter((e) => e.phase === "sealed" && e.iouCount > 0 && e.settleTx);
  const epoch = [...sealed].sort((a, b) => b.transfersAvoided - a.transfersAvoided || b.id - a.id)[0];
  const { data: detail } = useApi<EpochDetail>(epoch ? `/v1/epochs/${epoch.id}` : null);
  const [ai, setAi] = useState<AiStatus | null | undefined>(undefined);
  useEffect(() => {
    fleet<{ ai?: AiStatus }>("/control/studios")
      .then((d) => setAi(d.ai ?? null))
      .catch(() => setAi(null));
  }, []);
  // what recording and adding up this settle-up cost on NEAR (the payment batch itself is not metered here)
  const gas = detail?.txs.filter((t) => t.kind !== "settle" && t.gas_used).reduce((n, t) => n + (t.gas_used ?? 0), 0) ?? 0;
  const cost = gas && detail ? { tgas: gas / 1e12, near: gas * NEAR_PER_GAS, perEntry: (gas * NEAR_PER_GAS) / Math.max(1, detail.epoch.iouCount), entries: detail.epoch.iouCount } : null;
  return {
    network: s?.network.name ?? "NEAR",
    testnet: /test|sandbox|local/i.test(s?.network.name ?? ""),
    agent,
    round,
    epoch,
    job: detail?.ious[0]?.jobId ?? null,
    contract: s?.deployment?.contract ?? null,
    token: s?.deployment?.token ?? null,
    intents: s?.intents,
    ai,
    cost,
  };
}

const fmtNear = (n: number) => (n >= 0.01 ? n.toFixed(3) : n >= 0.0001 ? n.toFixed(5) : n.toPrecision(2));

/** The ways Yuki uses NEAR, each with a plain sentence, the NEAR name for it, and live proof. */
export function BuiltOnNear({ compact = false }: { compact?: boolean }) {
  const p = useNearProof();
  const rows: { plain: string; term: string; proof: ReactNode; key: string }[] = [
    {
      key: "accounts",
      plain: "Every agent has its own NEAR account",
      term: "Named accounts",
      proof: p.agent ? <OnNear account={p.agent.account} label={p.agent.account} /> : null,
    },
    {
      key: "contract",
      plain: "Auctions and the tab are run by a NEAR smart contract",
      term: "Smart contract",
      proof: p.round ? <OnNear tx={p.round.closeTx} label={`Auction #${p.round.id} closed`} /> : <OnNear account={p.contract} label="The contract" />,
    },
    {
      key: "signed",
      plain: "Every tab entry is signed by the buyer, and the contract checks the signature",
      term: "NEP-413 signatures",
      proof: p.job ? (
        <Link className="link" to={`/jobs/${p.job}`}>
          See a signed entry →
        </Link>
      ) : null,
    },
    {
      key: "intents",
      plain: "Everyone is paid in one batch: all the payments go through, or none do",
      term: p.intents?.kind === "near-intents" ? "NEAR Intents" : "NEAR Intents (testnet stand-in)",
      proof: p.epoch ? <OnNear tx={p.epoch.settleTx} label={`Settle-up ${p.epoch.id} paid`} /> : null,
    },
    {
      key: "rpc",
      plain: "Your browser reads the records straight from NEAR and checks every number",
      term: "NEAR RPC",
      proof: (
        <Link className="link" to="/verify">
          Check it yourself →
        </Link>
      ),
    },
    {
      key: "wallet",
      plain: "You sign in and set spending limits with your NEAR wallet",
      term: "NEAR wallets",
      proof: (
        <Link className="link" to="/dashboard">
          Connect a wallet →
        </Link>
      ),
    },
    {
      key: "ai",
      plain: "Agents can write with a private AI model, and each answer is signed",
      term: "NEAR AI Cloud",
      proof: p.ai === undefined ? <span className="faint">Checking…</span> : p.ai?.enabled ? <span className="tag good">Answering · {p.ai.model.split("/").pop()}</span> : <span className="tag">Offline right now</span>,
    },
    {
      key: "token",
      plain: "Payments use a standard NEAR token",
      term: p.testnet ? "NEP-141 token (test USDC)" : "NEP-141 token",
      proof: <OnNear account={p.token} label={p.token ?? "Token"} />,
    },
  ];
  const shown = compact ? rows.filter((r) => ["accounts", "contract", "signed", "intents", "ai"].includes(r.key)) : rows;
  return (
    <div className="near-rows">
      {shown.map((r, i) => (
        <div key={r.key} className="near-row">
          <span className="near-n">{i + 1}</span>
          <div className="near-what">
            <strong>{r.plain}</strong>
            <span className="near-term">
              <NearGlyph /> {r.term}
            </span>
          </div>
          <div className="near-proof">{r.proof}</div>
        </div>
      ))}
    </div>
  );
}

/** What a settle-up actually cost on NEAR, from measured gas. */
export function NearCost() {
  const p = useNearProof();
  if (!p.cost || !p.epoch) return null;
  return (
    <div className="near-cost">
      <div>
        <span className="label">Recording and adding up {plural(p.cost.entries, "tab entry", "tab entries")} on NEAR</span>
        <div className="fig">
          {p.cost.tgas.toFixed(1)} TGas <small>≈ {fmtNear(p.cost.near)} NEAR at NEAR's base gas price</small>
        </div>
      </div>
      <div>
        <span className="label">Per tab entry</span>
        <div className="fig">
          ≈ {fmtNear(p.cost.perEntry)} NEAR <small>settle-up {p.epoch.id} · measured gas, not an estimate</small>
        </div>
      </div>
    </div>
  );
}
