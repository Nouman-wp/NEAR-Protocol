import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { AgentSummary, JobView, SettlementView, TransferView } from "@quorum/core";
import { usd } from "../lib/format.ts";
import { AgentChip, Empty, Tag, Tx } from "./ui.tsx";

/**
 * The signed-in user's history as plain sentences: who hired whom, for what, what it cost,
 * and where the money is now (owed until the epoch closes, then paid on chain).
 */

interface Activity {
  jobs: JobView[];
  settlements: SettlementView[];
  transfers: TransferView[];
  totals: { bought: string; sold: string; jobs: number };
}

type Filter = "all" | "bought" | "sold" | "paid";
type Kind = "good" | "warn" | "bad" | "live" | undefined;

type Entry =
  | { type: "job"; at: number; job: JobView; bought: boolean }
  | { type: "pay"; at: number; s: SettlementView; lines: TransferView[] }
  | { type: "received"; at: number; epoch: number; lines: TransferView[] };

const NOT_CHARGED = new Set(["voided", "refused"]);

/** A service's readable name from the seller's listing ("design-studio" → "Brand kit"). */
function serviceName(agents: AgentSummary[], seller: string, id: string): string {
  const listed = agents.find((a) => a.agentId === seller)?.services.find((s) => s.id === id)?.name;
  if (listed) return listed;
  const words = id.replace(/[-_]+/g, " ");
  return words[0]!.toUpperCase() + words.slice(1);
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

function jobState(j: JobView, bought: boolean): { text: string; kind: Kind; hint: string } {
  switch (j.status) {
    case "settled":
      return { text: bought ? "Paid" : "Received", kind: "good", hint: `Settled on chain when epoch #${j.epoch} closed.` };
    case "delivered":
      return {
        text: bought ? "Owed" : "Owed to you",
        kind: "warn",
        hint: `Delivered. A signed IOU for now; it is netted and paid on chain when epoch #${j.epoch} closes (every ~90 s).`,
      };
    case "accepted":
      return { text: "In progress", kind: "live", hint: "Accepted; the seller is doing the work." };
    case "quoted":
      return { text: "Quoted", kind: "live", hint: "Price agreed, work not started yet." };
    case "disputed":
      return { text: "Disputed", kind: "warn", hint: "Under review by the validator. If the dispute is upheld, nothing is charged." };
    case "voided":
      return { text: "Not charged", kind: undefined, hint: "Voided, for example after an upheld dispute." };
    case "refused":
      return { text: "Not charged", kind: "bad", hint: "Refused: outside the spending limit or the seller's terms." };
  }
}

function payState(s: SettlementView): { text: string; kind: Kind; hint: string } {
  switch (s.status) {
    case "recorded":
      return { text: "Paid on chain", kind: "good", hint: "Executed in one NEAR Intents batch and marked settled by the contract." };
    case "submitted":
      return { text: "Signed, in the batch", kind: "live", hint: "Your agent signed its transfers; the batch settles in a few seconds." };
    case "awaiting_payment":
      return { text: "Waiting for signature", kind: "warn", hint: "Your agent signs its net transfers automatically, usually within seconds." };
    case "defaulted":
      return { text: "Covered by collateral", kind: "bad", hint: "The agent did not sign in time, so its collateral paid the debt." };
    case "failed":
      return { text: "Retrying", kind: "bad", hint: s.error ?? "The settlement failed and is retried automatically." };
  }
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function Item({ icon, tone, title, amount, state, meta }: { icon: string; tone: "out" | "in" | "pay"; title: ReactNode; amount: ReactNode; state: { text: string; kind: Kind; hint: string }; meta: ReactNode }) {
  return (
    <li className="feed-item">
      <span className={`feed-icon ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <div className="feed-body">
        <div className="feed-title">{title}</div>
        <div className="feed-meta">{meta}</div>
      </div>
      <div className="feed-side">
        <span className={`num feed-amount ${tone}`}>{amount}</span>
        <span title={state.hint}>
          <Tag kind={state.kind}>{state.text}</Tag>
        </span>
      </div>
    </li>
  );
}

export function History({ activity, mine, agents }: { activity: Activity | null; mine: Set<string>; agents: AgentSummary[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(25);

  const { entries, sums } = useMemo(() => {
    const jobs = activity?.jobs ?? [];
    const transfers = activity?.transfers ?? [];
    const list: Entry[] = jobs.map((job) => ({ type: "job", at: job.createdAt, job, bought: mine.has(job.buyer) }));
    for (const s of activity?.settlements ?? []) {
      list.push({ type: "pay", at: s.updatedAt || s.createdAt, s, lines: transfers.filter((t) => t.epoch === s.epoch && t.from === s.agentId) });
    }
    // money that came in: one entry per epoch, placed after the last sale in it
    const inbound = new Map<number, TransferView[]>();
    for (const t of transfers) if (mine.has(t.to) && !mine.has(t.from) && t.status === "settled") inbound.set(t.epoch, [...(inbound.get(t.epoch) ?? []), t]);
    for (const [epoch, lines] of inbound) {
      const last = Math.max(0, ...jobs.filter((j) => j.epoch === epoch && mine.has(j.seller)).map((j) => j.deliveredAt ?? j.createdAt));
      if (last) list.push({ type: "received", at: last + 1, epoch, lines });
    }
    list.sort((a, b) => b.at - a.at);

    let owed = 0n;
    let paid = 0n;
    for (const j of jobs) if (mine.has(j.buyer) && ["quoted", "accepted", "delivered", "disputed"].includes(j.status)) owed += BigInt(j.price);
    for (const s of activity?.settlements ?? []) if (s.status === "recorded") paid += BigInt(s.amount);
    return { entries: list, sums: { owed, paid } };
  }, [activity, mine]);

  const shown = entries.filter((e) => filter === "all" || (filter === "bought" ? e.type === "job" && e.bought : filter === "sold" ? (e.type === "job" && !e.bought) || e.type === "received" : e.type !== "job"));
  const days: { label: string; items: Entry[] }[] = [];
  for (const e of shown.slice(0, limit)) {
    const label = dayLabel(e.at);
    if (days[days.length - 1]?.label === label) days[days.length - 1]!.items.push(e);
    else days.push({ label, items: [e] });
  }

  const render = (e: Entry) => {
    if (e.type === "job") {
      const j = e.job;
      const service = serviceName(agents, j.seller, j.service);
      const free = NOT_CHARGED.has(j.status);
      const me = e.bought ? j.buyer : j.seller;
      const other = e.bought ? j.seller : j.buyer;
      return (
        <Item
          key={`j${j.id}`}
          icon={e.bought ? "↗" : "↙"}
          tone={e.bought ? "out" : "in"}
          title={
            e.bought ? (
              <>
                <AgentChip id={me} agents={agents} /> hired <AgentChip id={other} agents={agents} /> for {article(service)} <strong>{service.toLowerCase()}</strong>
              </>
            ) : (
              <>
                <AgentChip id={other} agents={agents} /> hired your agent <AgentChip id={me} agents={agents} /> for {article(service)} <strong>{service.toLowerCase()}</strong>
              </>
            )
          }
          amount={free ? <s>{usd(j.price, 4)}</s> : `${e.bought ? "−" : "+"}${usd(j.price, 4)}`}
          state={jobState(j, e.bought)}
          meta={
            <>
              {timeOf(j.createdAt)} · {j.roundId ? <>price set by sealed-bid <Link to={`/rounds/${j.roundId}`}>round #{j.roundId}</Link></> : "posted price"} · <Link to={`/epochs/${j.epoch}`}>epoch #{j.epoch}</Link> ·{" "}
              <Link className="link" to={`/jobs/${j.id}`}>
                receipt
              </Link>
            </>
          }
        />
      );
    }
    if (e.type === "pay") {
      const s = e.s;
      return (
        <Item
          key={`p${s.id}`}
          icon="✓"
          tone="pay"
          title={
            <>
              <AgentChip id={s.agentId} agents={agents} /> paid what it owed for <Link to={`/epochs/${s.epoch}`}>epoch #{s.epoch}</Link>
              {e.lines.length > 0 && (
                <span className="feed-lines">
                  {" "}
                  to{" "}
                  {e.lines.map((t, i) => (
                    <span key={`${t.to}-${i}`}>
                      {i > 0 && ", "}
                      <AgentChip id={t.to} agents={agents} /> <span className="num">{usd(t.amount, 4)}</span>
                    </span>
                  ))}
                </span>
              )}
            </>
          }
          amount={`−${usd(s.amount, 4)}`}
          state={payState(s)}
          meta={
            <>
              {timeOf(s.updatedAt || s.createdAt)} · all its IOUs in the epoch netted into one payment, sent straight to the agents who did the work · {s.settleTx ? <Tx hash={s.settleTx} label="NEAR Intents transaction" /> : "NEAR Intents batch pending"}
            </>
          }
        />
      );
    }
    const total = e.lines.reduce((a, t) => a + BigInt(t.amount), 0n);
    return (
      <Item
        key={`r${e.epoch}`}
        icon="✓"
        tone="in"
        title={
          <>
            Your agents were paid for <Link to={`/epochs/${e.epoch}`}>epoch #{e.epoch}</Link> by{" "}
            {e.lines.map((t, i) => (
              <span key={`${t.from}-${i}`}>
                {i > 0 && ", "}
                <AgentChip id={t.from} agents={agents} />
              </span>
            ))}
          </>
        }
        amount={`+${usd(total, 4)}`}
        state={{ text: "Received", kind: "good", hint: "Paid on chain through NEAR Intents." }}
        meta={<>{e.lines[0]?.tx ? <Tx hash={e.lines[0].tx} label="view transaction" /> : "settled on chain"}</>}
      />
    );
  };

  return (
    <section className="stack" style={{ gap: 16 }}>
      <div className="spread" style={{ flexWrap: "wrap" }}>
        <span className="label">History</span>
        <div className="seg" role="radiogroup" aria-label="Filter history">
          {(
            [
              ["all", "All"],
              ["bought", "Bought"],
              ["sold", "Sold"],
              ["paid", "Payments"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card how-pay">
        {[
          ["1", "Your agent hires", "It signs an IOU for the price. No money moves yet."],
          ["2", "The epoch closes", "Every ~90 s all IOUs are checked and netted, so each agent owes one total."],
          ["3", "One payment on chain", "Your agent signs that total, and it settles in one NEAR Intents batch."],
        ].map(([n, t, d]) => (
          <div key={n} className="how-step">
            <span className="how-n">{n}</span>
            <div className="stack" style={{ gap: 2 }}>
              <strong>{t}</strong>
              <span className="muted">{d}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid g4 history-sums">
        {[
          ["Spent", usd(activity?.totals.bought ?? "0", 4), "jobs your agents bought"],
          ["Earned", usd(activity?.totals.sold ?? "0", 4), "jobs your agents sold"],
          ["Owed, not paid yet", usd(sums.owed, 4), "settles when the epoch closes"],
          ["Paid on chain", usd(sums.paid, 4), "through NEAR Intents"],
        ].map(([label, value, note]) => (
          <div key={label} className="card mini-stat">
            <span className="label">{label}</span>
            <span className="num">{value}</span>
            <small className="faint">{note}</small>
          </div>
        ))}
      </div>

      <div className="card flush">
        {days.length === 0 ? (
          <Empty>{filter === "all" ? "Nothing yet. Launch an agent, sign its spending limit and hire a team: every job and payment shows up here." : "Nothing here yet."}</Empty>
        ) : (
          days.map((d) => (
            <div key={d.label} className="feed-day">
              <div className="feed-day-label">{d.label}</div>
              <ul className="feed">{d.items.map(render)}</ul>
            </div>
          ))
        )}
        {shown.length > limit && (
          <div style={{ padding: "14px 20px", borderTop: "1px solid var(--line)" }}>
            <button className="btn sm ghost" onClick={() => setLimit((l) => l + 25)}>
              Show older ({shown.length - limit} more)
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
