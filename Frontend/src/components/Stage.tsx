import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { RoundView } from "@quorum/core";
import { useApi, useLive, type EpochDetail } from "../lib/api.ts";
import { openDebts } from "../lib/derive.ts";
import { clock, plural, serviceName, usd } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { Tx } from "./ui.tsx";

/**
 * The live floor as a three-part story, played from real events, drawn as a simple flow:
 * who bids or owes on the left, who is paid on the right, and the lines between them.
 *   1. Auction    — sealed bids go to the buyer, open together, and the winner lights up.
 *   2. Tab        — every job on the tab is a thin line from the agent who owes to the one owed.
 *   3. Settle-up  — the thin lines fade and a few thick payments take their place.
 * The stage follows whatever is happening; you can also pick a part yourself. Between demos
 * it replays the last settle-up, labelled "Last time", so it is never empty.
 */

type Mode = "auction" | "tab" | "settle";
const MODES: [Mode, string][] = [
  ["auction", "Auction"],
  ["tab", "Tab"],
  ["settle", "Settle-up"],
];

const ROW = 56; // px per agent row
const MAX_ROWS = 7;

interface Side {
  id: string;
  note?: ReactNode;
  cls?: string;
}
interface Line {
  from: string;
  to: string;
  cls: "bid" | "win" | "tab" | "ghost" | "pay";
  weight?: number;
  label?: string;
}

const recently = (ts: number | null | undefined, ms: number, now: number) => !!ts && now - ts < ms;

/** Keep the first MAX_ROWS agents on a side; say how many more there are. */
function fit(list: Side[]): { shown: Side[]; more: number } {
  return list.length > MAX_ROWS ? { shown: list.slice(0, MAX_ROWS - 1), more: list.length - (MAX_ROWS - 1) } : { shown: list, more: 0 };
}

function Column({ title, items, more, align }: { title: string; items: Side[]; more: number; align: "left" | "right" }) {
  const live = useLive();
  return (
    <div className={`flow-col ${align}`}>
      <span className="flow-title">{title}</span>
      {items.map((s) => {
        const a = live.agents.find((x) => x.agentId === s.id);
        return (
          <Link key={s.id} to={`/agents/${s.id}`} className={`flow-agent${s.cls ? ` ${s.cls}` : ""}`} style={{ height: ROW }}>
            <Avatar id={s.id} role={a?.role} size={32} />
            <span className="who">
              <strong>{a?.name ?? `Agent #${s.id}`}</strong>
              <small>{a?.role ?? ""}</small>
            </span>
            {s.note && <span className="note-chip">{s.note}</span>}
          </Link>
        );
      })}
      {more > 0 && (
        <span className="flow-more" style={{ height: ROW }}>
          + {more} more
        </span>
      )}
    </div>
  );
}

export function Stage() {
  const live = useLive();
  const [now, setNow] = useState(Date.now());
  const [pinned, setPinned] = useState<Mode | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
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
  const { data: detail } = useApi<EpochDetail>(settleTarget ? `/v1/epochs/${settleTarget.id}` : null, 6_000);

  const auto: Mode = openRound || justClosed ? "auction" : settling ? "settle" : debts.count > 0 ? "tab" : "settle";
  const mode = pinned ?? auto;
  const round: RoundView | undefined = openRound ?? justClosed ?? lastClosed;
  const name = (id: string | null | undefined) => live.agents.find((a) => a.agentId === id)?.name ?? (id ? `Agent #${id}` : "");

  // ---- build the two columns and the lines between them, by stage
  let left: Side[] = [];
  let right: Side[] = [];
  let lines: Line[] = [];
  let titles: [string, string] = ["", ""];
  let caption: { small: string; big: string; foot?: ReactNode } = { small: "", big: "" };
  let empty: string | null = null;

  if (mode === "auction") {
    titles = ["Sellers bid", "Buyer"];
    if (!round) empty = "No auction yet. Press Run demo.";
    else {
      const closed = round.status === "Closed";
      left = [...round.bids]
        .sort((a, b) => (a.price === null ? 1 : b.price === null ? -1 : Number(a.price) - Number(b.price)))
        .map((b) => ({
          id: b.seller,
          cls: closed && round.winner === b.seller ? "winner" : undefined,
          note:
            b.price === null ? (
              <span className="sealed-chip" title="Sealed: nobody can see this price yet">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <rect x="3" y="6" width="18" height="12" rx="2" />
                  <path d="m3.5 7 8.5 6 8.5-6" />
                </svg>
                Sealed
              </span>
            ) : (
              <>{usd(b.price)}</>
            ),
        }));
      const buyers = round.kind === "GroupBuy" ? round.demand.map((d) => d.buyer) : [round.opener];
      right = buyers.map((id) => ({ id, note: round.kind === "GroupBuy" ? `wants ${round.demand.find((d) => d.buyer === id)?.quantity ?? ""}` : undefined }));
      lines = round.bids.map((b) => ({ from: b.seller, to: buyers[0]!, cls: closed && round.winner === b.seller ? "win" : "bid" }));
      const what = round.title || serviceName(round.service);
      const revealed = round.bids.filter((b) => b.price !== null).length;
      caption = closed
        ? { small: `${openRound || justClosed ? "Just finished" : "Last auction"} · ${what}`, big: `${name(round.winner)} wins`, foot: <>Lowest bid wins · paid {usd(round.clearingPrice)}</> }
        : round.phase === "revealing"
          ? { small: what, big: "Opening the bids", foot: `${revealed} of ${plural(round.bids.length, "bid")} open` }
          : { small: what, big: plural(round.bids.length, "sealed bid"), foot: "Nobody can see the prices yet" };
    }
  } else if (mode === "tab") {
    titles = ["Owes", "Is owed"];
    if (debts.count === 0) empty = "Nothing on the tab right now. Press Run demo.";
    else {
      const owes = new Map<string, bigint>();
      const owed = new Map<string, bigint>();
      for (const e of debts.edges) {
        owes.set(e.from, (owes.get(e.from) ?? 0n) + e.amount);
        owed.set(e.to, (owed.get(e.to) ?? 0n) + e.amount);
      }
      const byAmount = (m: Map<string, bigint>) => [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
      left = byAmount(owes).map(([id, v]) => ({ id, note: usd(v) }));
      right = byAmount(owed).map(([id, v]) => ({ id, note: usd(v) }));
      const max = Math.max(1, ...debts.edges.map((e) => e.count));
      lines = debts.edges.map((e) => ({ from: e.from, to: e.to, cls: "tab", weight: 1 + (e.count / max) * 2 }));
      const cur = s ? live.epochs.get(s.currentEpoch) : undefined;
      caption = {
        small: "On the tab right now",
        big: plural(debts.count, "entry", "entries"),
        foot: cur && cur.intakeEndsAt > now ? <>Settle-up in {clock(cur.intakeEndsAt - now)}</> : "Settling up soon",
      };
    }
  } else {
    titles = ["Pays", "Gets paid"];
    if (!detail || !settleTarget) empty = "Nothing settled yet. Press Run demo.";
    else {
      const e = detail.epoch;
      const pay = new Map<string, bigint>();
      const get = new Map<string, bigint>();
      for (const t of detail.transfers) {
        pay.set(t.from, (pay.get(t.from) ?? 0n) + BigInt(t.amount));
        get.set(t.to, (get.get(t.to) ?? 0n) + BigInt(t.amount));
      }
      // agents who only appear in the tab (they came out even) still get a row, so their faded lines have somewhere to go
      for (const i of detail.ious) {
        if (!pay.has(i.buyer) && !get.has(i.buyer)) pay.set(i.buyer, 0n);
        if (!get.has(i.seller) && !pay.has(i.seller)) get.set(i.seller, 0n);
      }
      const byAmount = (m: Map<string, bigint>) => [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
      left = byAmount(pay).map(([id, v]) => ({ id, note: v > 0n ? usd(v) : "even", cls: v === 0n ? "even" : undefined }));
      right = byAmount(get).map(([id, v]) => ({ id, note: v > 0n ? `+${usd(v)}` : "even", cls: v === 0n ? "even" : "paid" }));
      const pairs = new Set<string>();
      const ghosts: Line[] = [];
      for (const i of detail.ious) {
        const k = `${i.buyer}>${i.seller}`;
        if (pairs.has(k)) continue;
        pairs.add(k);
        ghosts.push({ from: i.buyer, to: i.seller, cls: "ghost" });
      }
      lines = [...ghosts, ...detail.transfers.map((t) => ({ from: t.from, to: t.to, cls: "pay" as const, label: usd(t.amount) }))];
      const tx = detail.transfers.find((t) => t.tx)?.tx;
      const replay = !settling;
      caption = {
        small: replay ? `Last time · settle-up ${e.id}` : `Settle-up ${e.id}`,
        big: `${plural(e.iouCount, "entry", "entries")} → ${plural(e.settlementTransfers || detail.transfers.length, "payment")}`,
        foot:
          e.phase === "sealed" ? (
            <span className="stage-paid">
              Paid on NEAR ✓ {tx && <Tx hash={tx} label="See it ↗" />}
            </span>
          ) : (
            "Adding up who owes whom…"
          ),
      };
    }
  }

  const L = fit(left);
  const R = fit(right);
  const rows = Math.max(L.shown.length + (L.more ? 1 : 0), R.shown.length + (R.more ? 1 : 0), 1);
  const H = rows * ROW;
  const yOf = (list: Side[], id: string) => {
    const i = list.findIndex((x) => x.id === id);
    return i < 0 ? null : i * ROW + ROW / 2;
  };
  const W = 100;
  const drawn = lines
    .map((l, i) => {
      const y1 = yOf(L.shown, l.from);
      const y2 = yOf(R.shown, l.to);
      if (y1 === null || y2 === null) return null;
      return { ...l, i, y1, y2, d: `M0,${y1} C${W * 0.5},${y1} ${W * 0.5},${y2} ${W},${y2}` };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  // only label the payments when there are few enough to read
  const labelPays = drawn.filter((l) => l.cls === "pay").length <= 5;
  const sceneKey = `${mode}-${mode === "auction" ? `${round?.id}-${round?.phase}` : mode === "settle" ? `${settleTarget?.id}-${detail?.epoch.phase}` : debts.count}`;

  return (
    <div className="stage">
      <div className="stage-steps" role="tablist" aria-label="What the stage shows">
        {MODES.map(([m, label], i) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setPinned(pinned === m ? null : m)}>
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

      {empty ? (
        <div className="stage-empty">
          <p className="h3">{empty}</p>
        </div>
      ) : (
        <div key={sceneKey}>
          <div className="stage-head" aria-live="polite">
            <span className="small">{caption.small}</span>
            <span className="big">{caption.big}</span>
            {caption.foot && <span className="foot">{caption.foot}</span>}
          </div>
          <div className="flow">
            <Column title={titles[0]} items={L.shown} more={L.more} align="left" />
            <div className="flow-mid" style={{ height: H + 30 }}>
              {/* the tab's faint lines, then (for a settle-up) the payments drawn over them, left to right */}
              {[drawn.filter((l) => l.cls === "ghost"), drawn.filter((l) => l.cls !== "ghost")].map((group, gi) => (
                <svg key={gi} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={gi === 0 ? "fl-layer ghosts" : `fl-layer fl-draw${mode === "settle" ? " late" : ""}`} style={{ top: 30, height: H }} aria-hidden="true">
                  {group.map((l) => (
                    <path key={`${l.cls}${l.from}>${l.to}${l.i}`} d={l.d} className={`fl ${l.cls}`} vectorEffect="non-scaling-stroke" style={{ strokeWidth: l.cls === "pay" || l.cls === "win" ? 3 : l.cls === "ghost" ? 1.2 : (l.weight ?? 1.5) }} />
                  ))}
                </svg>
              ))}
              {labelPays &&
                drawn
                  .filter((l) => l.cls === "pay" && l.label)
                  .map((l) => (
                    <span key={`lab${l.i}`} className="flow-label" style={{ top: 30 + (l.y1 + l.y2) / 2 }}>
                      {l.label}
                    </span>
                  ))}
            </div>
            <Column title={titles[1]} items={R.shown} more={R.more} align="right" />
          </div>
        </div>
      )}
      <p className="stage-hint">
        {mode === "auction"
          ? "Sellers send sealed bids to the buyer. The bids open together, and the lowest one wins."
          : mode === "tab"
            ? "Each line is a job on the tab: who owes whom. No money has moved yet."
            : "The faint lines were the tab. The thick ones are the few real payments, made on NEAR in one go."}
      </p>
    </div>
  );
}
