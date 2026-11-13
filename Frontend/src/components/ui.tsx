import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { AgentSummary } from "@quorum/core";
import { clock, explorerAccount, explorerTx, short, statusName, usd, usdExact } from "../lib/format.ts";
import { useLive } from "../lib/api.ts";

/** A stable colour per agent from the brand's range: burgundy through blush to sage. */
export function hue(id: string | number): string {
  // mid tones that read on both the off-white and the burgundy ground
  const palette = ["#c8707f", "#8c2c40", "#7b836e", "#b8956a", "#a35d6c", "#5e6852", "#d9a8b1", "#9aa58a"];
  return palette[Number(id) % palette.length]!;
}

/** ↗ : only for links that open somewhere else (GitHub, the NEAR explorer, a download). */
export const Arrow = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M2 10 10 2M4 2h6v6" />
  </svg>
);

/** → : for links and actions that stay on this site. */
export const Go = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M1.5 6h9M6.5 2l4 4-4 4" />
  </svg>
);

export const Mark = () => (
  <svg viewBox="0 0 26 26" fill="none" aria-hidden="true">
    <circle cx="13" cy="13" r="11.2" stroke="currentColor" strokeWidth="1.3" opacity=".55" />
    <circle cx="13" cy="4.6" r="2.6" fill="currentColor" />
    <circle cx="5.7" cy="17.2" r="2.6" fill="currentColor" />
    <circle cx="20.3" cy="17.2" r="2.6" fill="currentColor" />
    <path d="M13 4.6 5.7 17.2h14.6Z" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

export function AgentChip({ id, agents, link = true }: { id: string | null | undefined; agents?: AgentSummary[]; link?: boolean }) {
  const live = useLive();
  if (!id) return <span className="faint">—</span>;
  const a = (agents ?? live.agents).find((x) => x.agentId === id);
  const body = (
    <>
      <i style={{ background: hue(id) }} />
      <span>{a?.name ?? `Agent #${id}`}</span>
    </>
  );
  return link ? (
    <Link className="chip" to={`/agents/${id}`} title={a?.account}>
      {body}
    </Link>
  ) : (
    <span className="chip">{body}</span>
  );
}

export function Tag({ kind, children }: { kind?: "good" | "warn" | "bad" | "live"; children: ReactNode }) {
  return <span className={`tag${kind ? ` ${kind}` : ""}`}>{children}</span>;
}

const STATUS: Record<string, "good" | "warn" | "bad" | "live" | undefined> = {
  sealed: "good",
  settled: "good",
  recorded: "good",
  Closed: "good",
  closed: "good",
  paid: "good",
  delivered: "good",
  active: "good",
  rejected: "good",
  netted: "good",
  intake: "live",
  Open: "live",
  committing: "live",
  revealing: "live",
  joining: "live",
  closing: "live",
  settling: "live",
  challenge: "live",
  submitted: "live",
  accepted: "live",
  open: "warn",
  awaiting_payment: "warn",
  owes: "warn",
  disputed: "warn",
  held_out: "warn",
  planned: "warn",
  Void: "bad",
  void: "bad",
  defaulted: "bad",
  failed: "bad",
  voided: "bad",
  upheld: "bad",
  refused: "bad",
  retired: "bad",
};

export function Status({ value }: { value: string }) {
  return <Tag kind={STATUS[value]}>{statusName(value)}</Tag>;
}

/** An amount, rounded for reading, with the exact value on hover. */
export function Money({ v, signed = false }: { v: string | number | bigint | null | undefined; signed?: boolean }) {
  if (v === null || v === undefined) return <span className="faint">—</span>;
  const n = BigInt(v);
  const text = signed && n > 0n ? `+${usd(n)}` : usd(n);
  return (
    <span className="num" title={usdExact(n)}>
      {text}
    </span>
  );
}

/** Proof for people who want it: hashes, contract calls, raw data. Closed by default. */
export function Details({ summary = "Show details", children, className = "" }: { summary?: string; children: ReactNode; className?: string }) {
  return (
    <details className={`details ${className}`}>
      <summary>{summary}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}

/** "← All auctions" above a detail page's title. */
export function Back({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="back" to={to}>
      <span aria-hidden="true">←</span> {children}
    </Link>
  );
}

/** The next step in the tour: Home → Live → Auction → Settle-up → Check it. */
export function NextStep({ to, title, text }: { to: string; title: string; text: string }) {
  return (
    <Link className="card click next-step" to={to}>
      <span className="eyebrow">Next</span>
      <span className="h3">{title}</span>
      <span className="muted">{text}</span>
    </Link>
  );
}

/** Copies text to the clipboard and says so for a moment. */
export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={done ? "Copied" : `${label} to clipboard`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** A transaction hash linked to the explorer when the network has one. */
export function Tx({ hash, label }: { hash: string | null | undefined; label?: string }) {
  const explorer = useLive().stats?.network.explorer ?? null;
  if (!hash) return <span className="faint">—</span>;
  const url = explorerTx(explorer, hash);
  // a hash reads in monospace; a label like "See on NEAR ↗" reads as normal text
  const text = <span className={label ? "nowrap" : "mono nowrap"}>{label ?? short(hash, 6)}</span>;
  return url ? (
    <a className="link" href={url} target="_blank" rel="noreferrer" title={hash}>
      {text}
    </a>
  ) : (
    <span title={`${hash} (local sandbox: no explorer)`}>{text}</span>
  );
}

export function Account({ id }: { id: string | null | undefined }) {
  const explorer = useLive().stats?.network.explorer ?? null;
  if (!id) return <span className="faint">—</span>;
  const url = explorerAccount(explorer, id);
  return url ? (
    <a className="link mono" href={url} target="_blank" rel="noreferrer">
      {id}
    </a>
  ) : (
    <span className="mono">{id}</span>
  );
}

/** A hash, shortened, with the full value on hover and a copy button. */
export function Hash({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="faint">—</span>;
  return (
    <span className="hash">
      <span className="mono" title={value}>
        {short(value, 6)}
      </span>
      <Copy text={value} />
    </span>
  );
}

export function Countdown({ to, done = "now" }: { to: number | null | undefined; done?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, []);
  if (!to) return <>—</>;
  const left = to - Date.now();
  return <span className="num">{left <= 0 ? done : clock(left)}</span>;
}

/** Fades its children up the first time they scroll into view. */
export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          el.classList.add("in");
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHead({ eyebrow, title, lead, back, children }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; back?: { to: string; label: string }; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        {back && <Back to={back.to}>{back.label}</Back>}
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="h2">{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {children && <div className="row page-actions">{children}</div>}
    </div>
  );
}

/** States what the page is waiting for, or what went wrong, instead of an empty screen. */
export function Loading({ error, what }: { error: string | null; what: string }) {
  return (
    <div className="page">
      <div className="wrap">
        <div className="card">
          <Empty>{error ? `Couldn't load ${what} (${error}). The service may be restarting: this page tries again on its own.` : `Loading ${what}…`}</Empty>
        </div>
      </div>
    </div>
  );
}
