import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import type { AgentSummary, RoundView } from "@quorum/core";
import { useApi, useLive, type EpochDetail } from "../lib/api.ts";
import { openDebts } from "../lib/derive.ts";
import { clock, plural, serviceName, usd } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { Tx } from "./ui.tsx";

/**
 * The live floor as a three-part story, played from real events:
 *   1. Auction    — sealed envelopes travel from the bidders to the buyer, open, and the winner lights up.
 *   2. Tab        — every new tab entry draws a thin line between two agents; a counter climbs.
 *   3. Settle-up  — the thin lines fade and a few thick arrows take their place: "23 entries → 6 payments".
 * The stage picks the part that is happening now; you can also pick one yourself.
 * Between demos it replays the last settle-up, labelled "Last time", so it is never empty.
 */

type Mode = "auction" | "tab" | "settle";
const MODES: [Mode, string][] = [
  ["auction", "Auction"],
  ["tab", "Tab"],
  ["settle", "Settle-up"],
];

/** Three neighbourhoods on the ring, so where an agent sits says what it is. */
function groupOf(role: string): 0 | 1 | 2 {
  const r = role.toLowerCase();
  if (/buyer|seller|client|guest|user/.test(r)) return 2;
  if (/fact|research|search|summar|translat|chart|validator/.test(r)) return 1;
  return 0;
}
const GROUP_NAMES = ["Teams", "Research", "Buyers & sellers"] as const;

interface Pos {
  a: AgentSummary;
  x: number;
  y: number;
  angle: number;
}

function useRing(agents: AgentSummary[]) {
  return useMemo(() => {
    const sorted = [...agents].sort((a, b) => groupOf(a.role) - groupOf(b.role) || Number(a.agentId) - Number(b.agentId));
    const GAP = 2; // empty slots between neighbourhoods
    const slots = sorted.length + GAP * 3;
    const R = 40;
    const pos = new Map<string, Pos>();
    const arcs: { name: string; mid: number }[] = [];
    let slot = 0;
    let last = -1;
    let first = 0;
    sorted.forEach((a, i) => {
      const g = groupOf(a.role);
      if (g !== last) {
        if (last !== -1) {
          arcs.push({ name: GROUP_NAMES[last as 0 | 1 | 2], mid: (first + slot - 1) / 2 });
          slot += GAP;
        }
        first = slot;
        last = g;
      }
      const angle = (slot / slots) * Math.PI * 2 - Math.PI / 2;
      pos.set(a.agentId, { a, angle, x: 50 + Math.cos(angle) * R, y: 50 + Math.sin(angle) * R });
      slot++;
      if (i === sorted.length - 1) arcs.push({ name: GROUP_NAMES[g], mid: (first + slot - 1) / 2 });
    });
    const labels = arcs.map((c) => {
      const angle = (c.mid / slots) * Math.PI * 2 - Math.PI / 2;
      // just outside the ring, but kept inside the box so long names are never cut off
      return { name: c.name, x: Math.min(84, Math.max(16, 50 + Math.cos(angle) * 47)), y: Math.min(97, Math.max(3, 50 + Math.sin(angle) * 47)) };
    });
    return { pos, labels };
  }, [agents]);
}

/** A gentle curve between two ring points, pulled towards the centre so parallel lines fan out. */
function curve(p: Pos, q: Pos, pull = 0.3): string {
  const mx = 50 + ((p.x + q.x) / 2 - 50) * pull;
  const my = 50 + ((p.y + q.y) / 2 - 50) * pull;
  return `M${p.x.toFixed(2)},${p.y.toFixed(2)} Q${mx.toFixed(2)},${my.toFixed(2)} ${q.x.toFixed(2)},${q.y.toFixed(2)}`;
}

/** The point a fraction t of the way along that curve (for envelopes and price tags). */
function along(p: Pos, q: Pos, t: number, pull = 0.3): { x: number; y: number } {
  const mx = 50 + ((p.x + q.x) / 2 - 50) * pull;
  const my = 50 + ((p.y + q.y) / 2 - 50) * pull;
  const u = 1 - t;
  return { x: u * u * p.x + 2 * u * t * mx + t * t * q.x, y: u * u * p.y + 2 * u * t * my + t * t * q.y };
}

const recently = (ts: number | null | undefined, ms: number, now: number) => !!ts && now - ts < ms;

export function Stage() {
  const live = useLive();
  const [now, setNow] = useState(Date.now());
  const [pinned, setPinned] = useState<Mode | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const { pos, labels } = useRing(live.agents);
  const debts = openDebts(live);
  const s = live.stats;

  // what is happening right now
  const rounds = [...live.rounds.values()].sort((a, b) => b.id - a.id);
  const openRound = rounds.find((r) => r.status === "Open");
  const justClosed = rounds.find((r) => r.status === "Closed" && recently(r.closedAt, 15_000, now));
  const lastClosed = rounds.find((r) => r.status === "Closed");
  const epochs = [...live.epochs.values()].sort((a, b) => b.id - a.id);
  const settling = epochs.find((e) => (e.phase === "closing" || e.phase === "settling" || e.phase === "challenge") && e.iouCount > 0 && e.id !== s?.currentEpoch);
  const lastSealed = epochs.find((e) => e.phase === "sealed" && e.iouCount > 0);
  const settleTarget = settling ?? lastSealed;
  const { data: settleDetail } = useApi<EpochDetail>(settleTarget ? `/v1/epochs/${settleTarget.id}` : null, 6_000);

  const auto: Mode = openRound || justClosed ? "auction" : settling ? "settle" : debts.count > 0 ? "tab" : "settle";
  const mode = pinned ?? auto;
  const round: RoundView | undefined = openRound ?? justClosed ?? lastClosed;
  const replay = mode === "settle" && !settling;

  // who takes part in this part of the story
  const active = new Set<string>();
  if (mode === "auction" && round) {
    active.add(round.opener);
    round.demand.forEach((d) => active.add(d.buyer));
    round.bids.forEach((b) => active.add(b.seller));
  } else if (mode === "tab") {
    debts.edges.forEach((e) => (active.add(e.from), active.add(e.to)));
  } else if (settleDetail) {
    settleDetail.ious.forEach((i) => (active.add(i.buyer), active.add(i.seller)));
  }
  const named = active.size <= 14;

  // the caption in the middle
  let caption: { small: string; big: string; foot?: ReactNode };
  if (mode === "auction") {
    if (!round) caption = { small: "No auction yet", big: "Press Run demo" };
    else {
      const what = round.title || serviceName(round.service);
      const revealed = round.bids.filter((b) => b.price !== null).length;
      const winner = live.agents.find((a) => a.agentId === round.winner)?.name;
      caption =
        round.status === "Closed"
          ? { small: `${openRound || justClosed ? "Just finished" : "Last auction"} · ${what}`, big: `${winner ?? "Winner"} wins`, foot: <>at {usd(round.clearingPrice)}</> }
          : round.phase === "revealing"
            ? { small: what, big: "Opening the bids", foot: `${revealed} of ${plural(round.bids.length, "bid")} open` }
            : { small: what, big: `${plural(round.bids.length, "sealed bid")}`, foot: "Nobody can see the prices yet" };
    }
  } else if (mode === "tab") {
    const cur = s ? live.epochs.get(s.currentEpoch) : undefined;
    caption = {
      small: "On the tab right now",
      big: plural(debts.count, "entry", "entries"),
      foot: cur && cur.intakeEndsAt > now ? <>Settle-up in {clock(cur.intakeEndsAt - now)}</> : "Settling up soon",
    };
  } else if (settleDetail && settleTarget) {
    const e = settleDetail.epoch;
    const tx = settleDetail.transfers.find((t) => t.tx)?.tx;
    caption = {
      small: replay ? `Last time · settle-up ${e.id}` : `Settle-up ${e.id}`,
      big: `${e.iouCount} → ${plural(e.settlementTransfers || settleDetail.transfers.length, "payment")}`,
      foot:
        e.phase === "sealed" ? (
          <span className="stage-paid">
            Paid on NEAR ✓ {tx && <Tx hash={tx} label="See it ↗" />}
          </span>
        ) : (
          "Adding up who owes whom…"
        ),
    };
  } else caption = { small: "Waiting for the first settle-up", big: "Press Run demo" };

  // the lines, by part of the story
  const lines: { key: string; d: string; cls: string; style?: CSSProperties }[] = [];
  const tags: { key: string; x: number; y: number; node: ReactNode; cls: string }[] = [];
  if (mode === "auction" && round) {
    const buyers = round.kind === "GroupBuy" ? round.demand.map((d) => d.buyer) : [round.opener];
    const target = pos.get(buyers[0] ?? round.opener);
    round.bids.forEach((b, i) => {
      const p = pos.get(b.seller);
      if (!p || !target) return;
      const win = round.winner === b.seller;
      lines.push({ key: `b${b.seller}`, d: curve(p, target, 0.45), cls: `ln bid${win ? " win" : ""}`, style: { animationDelay: `${i * 0.25}s` } });
      const at = along(p, target, round.status === "Closed" ? 0.62 : 0.42, 0.45);
      tags.push({
        key: `t${b.seller}`,
        x: at.x,
        y: at.y,
        cls: b.price === null ? "env" : win ? "price win" : "price",
        node:
          b.price === null ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <rect x="3" y="6" width="18" height="12" rx="2" />
              <path d="m3.5 7 8.5 6 8.5-6" />
            </svg>
          ) : (
            <>{usd(b.price)}</>
          ),
      });
    });
    round.demand.slice(1).forEach((d) => {
      const p = pos.get(d.buyer);
      if (p && target) lines.push({ key: `j${d.buyer}`, d: curve(p, target, 0.6), cls: "ln join" });
    });
  } else if (mode === "tab") {
    debts.edges.forEach((e, i) => {
      const p = pos.get(e.from);
      const q = pos.get(e.to);
      if (p && q) lines.push({ key: `e${e.from}>${e.to}`, d: curve(p, q), cls: "ln tab", style: { animationDelay: `${Math.min(i, 20) * 0.05}s` } });
    });
  } else if (settleDetail) {
    const pairs = new Set<string>();
    settleDetail.ious.forEach((i) => {
      const k = `${i.buyer}>${i.seller}`;
      if (pairs.has(k)) return;
      pairs.add(k);
      const p = pos.get(i.buyer);
      const q = pos.get(i.seller);
      if (p && q) lines.push({ key: `g${k}`, d: curve(p, q), cls: "ln ghost" });
    });
    settleDetail.transfers.forEach((t, i) => {
      const p = pos.get(t.from);
      const q = pos.get(t.to);
      if (p && q) lines.push({ key: `p${t.from}>${t.to}${i}`, d: curve(p, q, 0.15), cls: "ln pay", style: { animationDelay: `${1.1 + i * 0.18}s` } });
    });
  }

  const sceneKey = `${mode}-${mode === "auction" ? `${round?.id}-${round?.phase}` : mode === "settle" ? `${settleTarget?.id}-${settleDetail?.epoch.phase}` : "tab"}`;

  return (
    <div className="stage">
      <div className="stage-steps" role="tablist" aria-label="What the stage shows">
        {MODES.map(([m, label], i) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`${mode === m ? "on" : ""}${auto === m ? " live" : ""}`} onClick={() => setPinned(pinned === m ? null : m)}>
            <span className="n">{i + 1}</span> {label}
            {auto === m && <span className="dot" title="Happening now" />}
          </button>
        ))}
        {pinned && (
          <button className="auto" onClick={() => setPinned(null)}>
            Follow live
          </button>
        )}
      </div>

      <div className="stage-ring" key={sceneKey}>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <marker id="stage-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M0 0 10 5 0 10Z" fill="var(--blush)" />
            </marker>
          </defs>
          <circle cx="50" cy="50" r="40" className="ring" />
          {lines.map((l) => (
            <path key={l.key} d={l.d} className={l.cls} style={l.style} pathLength={1} markerEnd={l.cls.includes("pay") ? "url(#stage-arrow)" : undefined} />
          ))}
        </svg>
        {labels.map((g) => (
          <span key={g.name} className="arc-label" style={{ left: `${g.x}%`, top: `${g.y}%` }}>
            {g.name}
          </span>
        ))}
        {[...pos.values()].map(({ a, x, y }) => {
          const on = active.has(a.agentId);
          return (
            <Link
              key={a.agentId}
              to={`/agents/${a.agentId}`}
              className={`node${on ? " on" : ""}${mode === "auction" && round?.winner === a.agentId && round.status === "Closed" ? " winner" : ""}`}
              style={{ left: `${x}%`, top: `${y}%` }}
              title={`${a.name} · ${a.role}`}
              aria-label={`${a.name}, ${a.role}`}
              tabIndex={on ? 0 : -1}
            >
              <Avatar id={a.agentId} role={a.role} size={on ? 30 : 12} />
              {on && named && <span className="name">{a.name}</span>}
            </Link>
          );
        })}
        {tags.map((t) => (
          <span key={t.key} className={`tag-on-line ${t.cls}`} style={{ left: `${t.x}%`, top: `${t.y}%` }}>
            {t.node}
          </span>
        ))}
        <div className="stage-caption" aria-live="polite">
          <span className="small">{caption.small}</span>
          <span className="big">{caption.big}</span>
          {caption.foot && <span className="foot">{caption.foot}</span>}
        </div>
      </div>
      <p className="stage-hint">
        {mode === "auction"
          ? "Sellers send sealed bids to the buyer. The bids open together, and the lowest one wins."
          : mode === "tab"
            ? "Each line is one job put on the tab: who owes whom. No money has moved yet."
            : "All those little debts become a few payments, paid on NEAR in one go."}
      </p>
    </div>
  );
}
