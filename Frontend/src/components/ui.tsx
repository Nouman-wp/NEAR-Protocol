import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { AgentSummary } from "@quorum/core";
import { clock, explorerAccount, explorerTx, short } from "../lib/format.ts";
import { useLive } from "../lib/api.ts";

/** A stable colour per agent from the brand's range: burgundy through blush to sage. */
export function hue(id: string | number): string {
  // mid tones that read on both the off-white and the burgundy ground
  const palette = ["#c8707f", "#8c2c40", "#7b836e", "#b8956a", "#a35d6c", "#5e6852", "#d9a8b1", "#9aa58a"];
  return palette[Number(id) % palette.length]!;
}

export const Arrow = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M2 10 10 2M4 2h6v6" />
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
  return <Tag kind={STATUS[value]}>{value.replace(/_/g, " ")}</Tag>;
}

/** A transaction hash linked to the explorer when the network has one. */
export function Tx({ hash, label }: { hash: string | null | undefined; label?: string }) {
  const explorer = useLive().stats?.network.explorer ?? null;
  if (!hash) return <span className="faint">—</span>;
  const url = explorerTx(explorer, hash);
  const text = <span className="mono nowrap">{label ?? short(hash, 6)}</span>;
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

export function PageHead({ eyebrow, title, lead, children }: { eyebrow: string; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="h2" style={{ marginTop: 16 }}>
          {title}
        </h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

/** States what the page is waiting for, or what went wrong, instead of an empty screen. */
export function Loading({ error, what }: { error: string | null; what: string }) {
  return (
    <div className="page">
      <div className="wrap">
        <div className="card">
          <Empty>{error ? `Could not load ${what}: ${error}. Is the clearing service running?` : `Loading ${what}…`}</Empty>
        </div>
      </div>
    </div>
  );
}
