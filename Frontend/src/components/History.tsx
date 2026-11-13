import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { AgentSummary, JobView, SettlementView, TransferView } from "@quorum/core";
import { usd } from "../lib/format.ts";
import { AgentChip, Empty, Tag, Tx } from "./ui.tsx";

/**
 * The signed-in user's history as plain sentences: who hired whom, for what, what it cost,
 * and where the money is now (owed until the settle-up, then paid on NEAR).
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
      return { text: bought ? "Paid" : "Received", kind: "good", hint: `Paid on NEAR in settle-up ${j.epoch}.` };
    case "delivered":
      return {
        text: bought ? "Owed" : "Owed to you",
        kind: "warn",
        hint: `Delivered. On the tab for now; paid on NEAR when settle-up ${j.epoch} closes (about every 90 seconds).`,
      };
    case "accepted":
      return { text: "In progress", kind: "live", hint: "Accepted; the seller is doing the work." };
    case "quoted":
      return { text: "Quoted", kind: "live", hint: "Price agreed, work not started yet." };
    case "disputed":
      return { text: "Complaint open", kind: "warn", hint: "An independent checker is looking at it. If the complaint is accepted, nothing is charged." };
    case "voided":
      return { text: "Not charged", kind: undefined, hint: "Cancelled, for example after an accepted complaint." };
    case "refused":
      return { text: "Not charged", kind: "bad", hint: "Refused: outside the spending limit or the seller's terms." };
  }
}

function payState(s: SettlementView): { text: string; kind: Kind; hint: string } {
  switch (s.status) {
    case "recorded":
      return { text: "Paid on NEAR", kind: "good", hint: "Paid in one batch with everyone else, and recorded on NEAR." };
    case "submitted":
      return { text: "Signed, paying now", kind: "live", hint: "Your agent signed its payments; they go through in a few seconds." };
    case "awaiting_payment":
      return { text: "Waiting to sign", kind: "warn", hint: "Your agent signs its payments on its own, usually within seconds." };
    case "defaulted":
      return { text: "Paid from deposit", kind: "bad", hint: "The agent didn't sign in time, so its deposit paid what it owed." };
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
          amount={free ? <s>{usd(j.price)}</s> : `${e.bought ? "−" : "+"}${usd(j.price)}`}
          state={jobState(j, e.bought)}
          meta={
            <>
              {timeOf(j.createdAt)} · {j.roundId ? <>price set in <Link to={`/rounds/${j.roundId}`}>auction #{j.roundId}</Link></> : "fixed price"} · <Link to={`/epochs/${j.epoch}`}>settle-up {j.epoch}</Link> ·{" "}
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
              <AgentChip id={s.agentId} agents={agents} /> paid what it owed in <Link to={`/epochs/${s.epoch}`}>settle-up {s.epoch}</Link>
              {e.lines.length > 0 && (
                <span className="feed-lines">
                  {" "}
                  to{" "}
                  {e.lines.map((t, i) => (
                    <span key={`${t.to}-${i}`}>
                      {i > 0 && ", "}
                      <AgentChip id={t.to} agents={agents} /> <span className="num">{usd(t.amount)}</span>
                    </span>
                  ))}
                </span>
              )}
            </>
          }
          amount={`−${usd(s.amount)}`}
          state={payState(s)}
          meta={
            <>
              {timeOf(s.updatedAt || s.createdAt)} · everything it owed in the settle-up, added up into one payment and sent straight to the agents who did the work · {s.settleTx ? <Tx hash={s.settleTx} label="See on NEAR ↗" /> : "payment pending"}
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
            Your agents were paid in <Link to={`/epochs/${e.epoch}`}>settle-up {e.epoch}</Link> by{" "}
            {e.lines.map((t, i) => (
              <span key={`${t.from}-${i}`}>
                {i > 0 && ", "}
                <AgentChip id={t.from} agents={agents} />
              </span>
            ))}
          </>
        }
        amount={`+${usd(total)}`}
        state={{ text: "Received", kind: "good", hint: "Paid on NEAR." }}
        meta={<>{e.lines[0]?.tx ? <Tx hash={e.lines[0].tx} label="See on NEAR ↗" /> : "paid on NEAR"}</>}
      />
    );
  };

  return (
    <section className="stack" style={{ gap: 16 }}>
      <div className="spread" style={{ flexWrap: "wrap" }}>
        <h2 className="h3">History</h2>
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
          ["1", "Your agent hires", "It puts the price on the tab. No money moves yet."],
          ["2", "The tab is added up", "About every 90 seconds, so each agent owes or is owed one total."],
          ["3", "One payment on NEAR", "Your agent signs that total, and everyone is paid in one go."],
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
          ["Spent", usd(activity?.totals.bought ?? "0"), "jobs your agents bought"],
          ["Earned", usd(activity?.totals.sold ?? "0"), "jobs your agents sold"],
          ["On the tab", usd(sums.owed), "paid at the next settle-up"],
          ["Paid on NEAR", usd(sums.paid), "settled and recorded"],
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
          <Empty>{filter === "all" ? "Nothing yet. Launch an agent, set its spending limit and hire a team: every job and payment shows up here." : "Nothing here yet."}</Empty>
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
