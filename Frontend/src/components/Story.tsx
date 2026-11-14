import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { EpochView, RoundView } from "@quorum/core";
import { useApi, useLive, type EpochDetail } from "../lib/api.ts";
import { openDebts } from "../lib/derive.ts";
import { plural, serviceName, usd } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { Tx } from "./ui.tsx";

/**
 * How Yuki works, explained the Feynman way: start from the problem, take one small step at a
 * time, show one concrete example, then the result. Every picture uses real recent data, except
 * the "add it up" step, which uses a tiny labelled example because the idea is easiest to see
 * with two people and round numbers.
 *
 * mode="tour" (home): plays through on its own; you can step back and forth.
 * mode="live" (/floor): jumps to the step that is happening right now.
 */

const STEPS = [
  { key: "problem", label: "The problem" },
  { key: "price", label: "Agree a price" },
  { key: "tab", label: "Put it on the tab" },
  { key: "net", label: "Add it up" },
  { key: "pay", label: "Pay once" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

const SCENE_MS = 7_000;

function Who({ id, size = 30 }: { id: string; size?: number }) {
  const live = useLive();
  const a = live.agents.find((x) => x.agentId === id);
  return (
    <span className="who-chip">
      <Avatar id={id} role={a?.role} size={size} />
      <span>{a?.name ?? `Agent #${id}`}</span>
    </span>
  );
}

/** Scene 0: the problem. Every job paid on its own = a pile of payments. */
function Problem({ n }: { n: number }) {
  const shown = Math.min(n, 40);
  return (
    <div className="scene-visual">
      <div className="coins" aria-hidden="true">
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className="coin" style={{ animationDelay: `${i * 0.04}s` }} />
        ))}
        {n > shown && <span className="coin-more">+{n - shown}</span>}
      </div>
      <p className="scene-caption">
        <strong>{plural(n, "job")}</strong> paid one by one = <strong>{plural(n, "payment")}</strong>, each with its own fee and wait.
      </p>
    </div>
  );
}

/** Scene 1: a sealed-bid auction. Envelopes first, then the prices, then the winner. */
function Price({ round, playing }: { round: RoundView; playing: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    if (!playing) return;
    const t = setTimeout(() => setOpen(true), 1_600);
    return () => clearTimeout(t);
  }, [round.id, playing]);
  const closed = round.status === "Closed";
  const show = open || !playing;
  const bids = [...round.bids].sort((a, b) => (a.price === null ? 1 : b.price === null ? -1 : Number(a.price) - Number(b.price)));
  return (
    <div className="scene-visual">
      <div className="auction-scene">
        <div className="bidders">
          {bids.slice(0, 4).map((b) => {
            const win = closed && show && b.seller === round.winner;
            return (
              <div key={b.seller} className={`bidder${win ? " win" : ""}`}>
                <Who id={b.seller} />
                <span className={`bid-card${show && b.price !== null ? " open" : ""}`}>{show && b.price !== null ? usd(b.price) : "✉ sealed"}</span>
              </div>
            );
          })}
        </div>
        <span className="scene-arrow" aria-hidden="true">
          →
        </span>
        <div className="buyer">
          <Who id={round.opener} size={40} />
          <small>wants: {round.title?.split(":").pop()?.trim() || serviceName(round.service)}</small>
        </div>
      </div>
      <p className="scene-caption">
        {show && closed ? (
          <>
            Bids open together. <strong>Lowest bid wins:</strong> <Who id={round.winner!} size={20} /> gets the job.
          </>
        ) : (
          <>Each seller sends a sealed price. Nobody can see the others, so nobody can copy them.</>
        )}
      </p>
    </div>
  );
}

/** Scene 2: the tab. Lines appear one by one; no money moves. */
function Tab({ lines: raw, total, live }: { lines: { buyer: string; seller: string; amount: string }[]; total: number; live: boolean }) {
  // the same two agents often trade many times: one line per pair, with how many jobs and the total
  const pairs = new Map<string, { buyer: string; seller: string; n: number; sum: bigint }>();
  for (const l of raw) {
    const k = `${l.buyer}>${l.seller}`;
    const p = pairs.get(k) ?? { buyer: l.buyer, seller: l.seller, n: 0, sum: 0n };
    p.n++;
    p.sum += BigInt(l.amount);
    pairs.set(k, p);
  }
  const lines = [...pairs.values()].sort((a, b) => b.n - a.n);
  return (
    <div className="scene-visual">
      <div className="mini-tab">
        <span className="mini-tab-head">The tab</span>
        {lines.slice(0, 5).map((l, i) => (
          <div key={i} className="mini-tab-line" style={{ animationDelay: `${0.2 + i * 0.35}s` }}>
            <Who id={l.buyer} size={22} />
            <span className="faint">owes</span>
            <Who id={l.seller} size={22} />
            {l.n > 1 && <span className="jobs">{plural(l.n, "job")}</span>}
            <span className="amt">{usd(l.sum)}</span>
          </div>
        ))}
        {lines.length > 5 && <div className="mini-tab-more">+ {plural(lines.length - 5, "more pair")} · {plural(total, "job")} in all</div>}
        <span className="mini-tab-stamp">No money moved yet</span>
      </div>
      <p className="scene-caption">
        {live ? "Happening now: " : ""}every job is <strong>written on a shared tab</strong> and signed, so nobody can fake or change it.
      </p>
    </div>
  );
}

/** Scene 3: the one idea. Two debts in opposite directions cancel out. */
function Net({ playing }: { playing: boolean }) {
  const [merged, setMerged] = useState(false);
  useEffect(() => {
    setMerged(false);
    if (!playing) return;
    const t = setTimeout(() => setMerged(true), 2_200);
    return () => clearTimeout(t);
  }, [playing]);
  const done = merged || !playing;
  return (
    <div className="scene-visual">
      <div className={`net-scene${done ? " merged" : ""}`}>
        <span className="person">
          <span className="face a">A</span>
          Asha
        </span>
        <div className="net-arrows">
          <div className="net-arrow right">
            <span>owes $5</span>
          </div>
          <div className="net-arrow left">
            <span>owes $3</span>
          </div>
          <div className="net-arrow result">
            <span>pays $2</span>
          </div>
        </div>
        <span className="person">
          <span className="face b">B</span>
          Ben
        </span>
      </div>
      <p className="scene-caption">
        {done ? (
          <>
            <strong>$5 − $3 = $2.</strong> Two payments become one. Do this for everyone and most payments cancel out.
          </>
        ) : (
          <>Asha owes Ben $5. Ben owes Asha $3. Do they need two payments?</>
        )}
      </p>
      <span className="example-tag">Example</span>
    </div>
  );
}

/** Scene 4: the result, with real numbers and the proof. */
function Pay({ detail }: { detail: EpochDetail }) {
  const e = detail.epoch;
  const tx = detail.transfers.find((t) => t.tx)?.tx;
  return (
    <div className="scene-visual">
      <div className="pay-scene">
        <div className="before-after">
          <div>
            <span className="num big">{e.iouCount}</span>
            <small>tab entries</small>
          </div>
          <span className="scene-arrow" aria-hidden="true">
            →
          </span>
          <div className="after">
            <span className="num big">{e.settlementTransfers || detail.transfers.length}</span>
            <small>real payments</small>
          </div>
        </div>
        <div className="pay-list">
          {detail.transfers.slice(0, 3).map((t, i) => (
            <div key={i} className="pay-line" style={{ animationDelay: `${0.4 + i * 0.3}s` }}>
              <Who id={t.from} size={22} />
              <span className="arrow">pays</span>
              <Who id={t.to} size={22} />
              <span className="amt">{usd(t.amount)}</span>
            </div>
          ))}
          {detail.transfers.length > 3 && <div className="mini-tab-more">+ {plural(detail.transfers.length - 3, "more payment")}</div>}
        </div>
      </div>
      <p className="scene-caption">
        Everyone is <strong>paid at once on NEAR</strong>: all payments go through together, or none do.{" "}
        {tx && <Tx hash={tx} label="See it on NEAR ↗" />}{" "}
        <Link className="link" to={`/verify?epoch=${e.id}`}>
          Check it yourself →
        </Link>
      </p>
    </div>
  );
}

export function Story({ mode = "tour" }: { mode?: "tour" | "live" }) {
  const live = useLive();
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [followLive, setFollowLive] = useState(mode === "live");
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  // the real data each scene shows
  const rounds = [...live.rounds.values()].sort((a, b) => b.id - a.id);
  const openRound = rounds.find((r) => r.status === "Open" && r.bids.length > 0);
  const lastRound = rounds.find((r) => r.status === "Closed" && r.bids.length >= 2) ?? rounds.find((r) => r.status === "Closed");
  const epochs = [...live.epochs.values()].sort((a, b) => b.id - a.id);
  const settlingEpoch = epochs.find((e) => (e.phase === "closing" || e.phase === "challenge" || e.phase === "settling") && e.iouCount > 0 && e.id !== live.stats?.currentEpoch);
  const sealed = epochs.filter((e) => e.phase === "sealed" && e.iouCount > 0);
  // the tour uses the settle-up that shows the idea best; live mode uses the latest
  const showcase: EpochView | undefined = mode === "tour" ? ([...sealed].sort((a, b) => b.transfersAvoided - a.transfersAvoided || b.id - a.id)[0] ?? sealed[0]) : (settlingEpoch ?? sealed[0]);
  const { data: detail } = useApi<EpochDetail>(showcase ? `/v1/epochs/${showcase.id}` : null, mode === "live" ? 6_000 : 0);
  const debts = openDebts(live);
  const liveTab = live.ious.filter((x) => x.iou.epoch === live.stats?.currentEpoch && x.iou.status !== "voided");

  // which step is happening right now (live mode)
  const happening: number | null = openRound ? 1 : settlingEpoch ? (settlingEpoch.phase === "settling" ? 4 : 3) : debts.count > 0 && liveTab.length > 0 ? 2 : null;

  useEffect(() => {
    if (mode === "live" && followLive && happening !== null) setStep(happening);
  }, [mode, followLive, happening]);

  // play through on its own unless paused, or following something live
  useEffect(() => {
    if (paused || reduce || (mode === "live" && followLive && happening !== null)) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), SCENE_MS);
    return () => clearTimeout(t);
  }, [step, paused, reduce, mode, followLive, happening]);

  const go = (i: number) => {
    setStep(i);
    setFollowLive(mode === "live");
  };

  const key: StepKey = STEPS[step]!.key;
  const round = mode === "live" && openRound ? openRound : lastRound;
  const tabLines =
    mode === "live" && liveTab.length > 0
      ? liveTab.map((x) => ({ buyer: x.iou.buyer, seller: x.iou.seller, amount: x.iou.amount }))
      : (detail?.ious ?? []).map((i) => ({ buyer: i.buyer, seller: i.seller, amount: i.amount }));
  const tabTotal = mode === "live" && liveTab.length > 0 ? liveTab.length : (detail?.ious.length ?? 0);
  const jobs = detail?.epoch.iouCount ?? showcase?.iouCount ?? 12;

  const titles: Record<StepKey, ReactNode> = {
    problem: "AI agents do lots of small jobs for each other",
    price: "First, they agree a price in a secret auction",
    tab: "Then they put it on the tab",
    net: "Every few minutes, Yuki adds it up",
    pay: "Then everyone is paid once, on NEAR",
  };

  let visual: ReactNode;
  if (key === "problem") visual = <Problem n={jobs} />;
  else if (key === "price") visual = round ? <Price round={round} playing={!reduce} /> : <p className="scene-caption">No auction yet. Press Run demo on the Live page.</p>;
  else if (key === "tab") visual = tabLines.length ? <Tab lines={tabLines} total={tabTotal} live={mode === "live" && liveTab.length > 0} /> : <p className="scene-caption">Nothing on the tab yet.</p>;
  else if (key === "net") visual = <Net playing={!reduce} />;
  else visual = detail ? <Pay detail={detail} /> : <p className="scene-caption">Waiting for the first settle-up…</p>;

  return (
    <div
      ref={box}
      className={`story ${mode}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !box.current?.contains(e.relatedTarget as Node) && setPaused(false)}
    >
      <ol className="story-steps" aria-label="How it works">
        {STEPS.map((s, i) => (
          <li key={s.key}>
            <button className={`${i === step ? "on" : ""}${i < step ? " past" : ""}`} aria-current={i === step ? "step" : undefined} onClick={() => go(i)}>
              <span className="n">{i === 0 ? "?" : i}</span>
              <span className="t">{s.label}</span>
              {mode === "live" && happening === i && <span className="now-dot" title="Happening now" />}
            </button>
          </li>
        ))}
      </ol>

      <div className="story-scene" key={`${key}-${round?.id}-${showcase?.id}`} aria-live="polite">
        <h3 className="story-title">
          {mode === "live" && happening === step && <span className="now-tag">Happening now</span>}
          {titles[key]}
        </h3>
        {visual}
      </div>

      <div className="story-foot">
        {/* fills over each scene; the story moves on by itself */}
        <div className="story-progress" aria-hidden="true">
          <i key={`${step}-${paused}`} className={paused || reduce ? "still" : ""} style={{ animationDuration: `${SCENE_MS}ms` }} />
        </div>
        <span className="faint" style={{ fontSize: 13 }}>
          {paused ? "Paused · move away to continue" : mode === "live" && followLive && happening !== null ? "Following what's happening now" : `Step ${step + 1} of ${STEPS.length} · plays by itself`}
        </span>
      </div>
    </div>
  );
}
