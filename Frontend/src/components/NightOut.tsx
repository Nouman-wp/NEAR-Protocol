import { useEffect, useRef, useState } from "react";

/**
 * "Keep a tab. Settle once." as a worked example that adds up.
 *
 * Four friends spend an evening paying for each other. Six small debts go on the tab.
 * Settling up = add up what each person is owed minus what they owe:
 *   Asha  +4 +2 −2 = +$4      Ben  −4 +3 +1 = $0
 *   Chen  −3 +5 −2 =  $0      Dev  −5 +2 −1 = −$4
 * so one payment settles all six: Dev pays Asha $4.
 *
 * It plays by itself (night → settle up → night …), pauses on hover, and has a button.
 */

type Name = "Asha" | "Ben" | "Chen" | "Dev";

const PEOPLE: Record<Name, { x: number; y: number; colour: string; what: string }> = {
  Asha: { x: 70, y: 62, colour: "#a35d6c", what: "☕" },
  Ben: { x: 330, y: 62, colour: "#7b836e", what: "🍕" },
  Chen: { x: 330, y: 238, colour: "#b8956a", what: "🎟" },
  Dev: { x: 70, y: 238, colour: "#5e6852", what: "🚕" },
};

/** who owes whom, for what, and how much (in dollars) */
const DEBTS: { from: Name; to: Name; amount: number; why: string; bend: number }[] = [
  { from: "Ben", to: "Asha", amount: 4, why: "Asha bought Ben a coffee", bend: -26 },
  { from: "Chen", to: "Ben", amount: 3, why: "Ben paid for Chen's pizza", bend: -26 },
  { from: "Dev", to: "Chen", amount: 5, why: "Chen got Dev's ticket", bend: -26 },
  { from: "Asha", to: "Dev", amount: 2, why: "Dev paid Asha's taxi", bend: -26 },
  { from: "Chen", to: "Asha", amount: 2, why: "Asha covered Chen's dessert", bend: 62 },
  { from: "Dev", to: "Ben", amount: 1, why: "Ben lent Dev a dollar", bend: 62 },
];

const NET: Record<Name, number> = { Asha: 0, Ben: 0, Chen: 0, Dev: 0 };
for (const d of DEBTS) {
  NET[d.from] -= d.amount;
  NET[d.to] += d.amount;
}

const R = 30; // person radius

/** A curved arrow between two people, stopping at the edge of each circle. Returns the path and its middle. */
function arrow(from: Name, to: Name, bend: number) {
  const a = PEOPLE[from];
  const b = PEOPLE[to];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const sx = a.x + ux * (R + 6);
  const sy = a.y + uy * (R + 6);
  const ex = b.x - ux * (R + 10);
  const ey = b.y - uy * (R + 10);
  // control point: the midpoint pushed sideways
  const mx = (sx + ex) / 2 - uy * bend;
  const my = (sy + ey) / 2 + ux * bend;
  // the curve's actual middle (t = 0.5 on a quadratic)
  const cx = 0.25 * sx + 0.5 * mx + 0.25 * ex;
  const cy = 0.25 * sy + 0.5 * my + 0.25 * ey;
  return { d: `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`, cx, cy };
}

export function NightOut() {
  const [settled, setSettled] = useState(false);
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (paused || reduce) return;
    const t = setTimeout(() => setSettled((s) => !s), settled ? 5_000 : 6_500);
    return () => clearTimeout(t);
  }, [settled, paused, reduce]);

  const payer = (Object.keys(NET) as Name[]).find((n) => NET[n] < 0)!;
  const payee = (Object.keys(NET) as Name[]).find((n) => NET[n] > 0)!;
  const final = arrow(payer, payee, 0);

  return (
    <div className={`night${settled ? " settled" : ""}`} ref={box} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="night-text">
        <span className="eyebrow">Like a night out</span>
        <h2 className="h2">Keep a tab. Settle once.</h2>
        <p className="lead">Friends don't pay after every coffee. They keep a tab, and at the end someone works out the totals. Yuki does that for AI agents.</p>

        <div className="night-tab" aria-label="The tab">
          <div className="night-tab-head">
            <span>The tab</span>
            <span className="count">{settled ? "6 debts → 1 payment" : "6 debts"}</span>
          </div>
          <ul>
            {DEBTS.map((d, i) => (
              <li key={i} style={{ transitionDelay: settled ? `${i * 0.08}s` : "0s" }}>
                <span>
                  <b>{d.from}</b> owes <b>{d.to}</b>
                </span>
                <span className="why">{d.why}</span>
                <span className="amt">${d.amount}</span>
              </li>
            ))}
          </ul>
          <div className="night-total">
            <span>
              <b>{payer}</b> pays <b>{payee}</b>
            </span>
            <span className="amt">${NET[payee]}</span>
          </div>
        </div>
      </div>

      <div className="night-visual">
        <svg viewBox="0 -34 400 368" role="img" aria-label={settled ? `After settling up: ${payer} pays ${payee} $${NET[payee]}. Everyone else is even.` : "Six small debts between four friends"}>
          <defs>
            <marker id="night-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 10 5 0 10Z" style={{ fill: "rgba(var(--blush-rgb), 0.75)" }} />
            </marker>
            <marker id="night-head-final" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0 10 5 0 10Z" style={{ fill: "var(--blush)" }} />
            </marker>
          </defs>
          {/* the six small debts */}
          <g className="debts">
            {DEBTS.map((d, i) => {
              const a = arrow(d.from, d.to, d.bend);
              return (
                <g key={i} className="debt" style={{ transitionDelay: settled ? `${i * 0.08}s` : `${i * 0.12}s` }}>
                  <path d={a.d} markerEnd="url(#night-head)" />
                  <g transform={`translate(${a.cx.toFixed(1)},${a.cy.toFixed(1)})`}>
                    <rect x="-17" y="-11" width="34" height="22" rx="11" />
                    <text textAnchor="middle" dy="4.5">
                      ${d.amount}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>

          {/* the one payment that settles everything */}
          <g className="final">
            <path d={final.d} markerEnd="url(#night-head-final)" />
            <g transform={`translate(${final.cx.toFixed(1)},${final.cy.toFixed(1)})`}>
              <rect x="-44" y="-15" width="88" height="30" rx="15" />
              <text textAnchor="middle" dy="5">
                pays ${NET[payee]}
              </text>
            </g>
          </g>

          {/* the friends */}
          {(Object.keys(PEOPLE) as Name[]).map((n) => {
            const p = PEOPLE[n];
            const even = NET[n] === 0;
            const top = p.y < 150;
            return (
              <g key={n} className={`friend${even ? " even" : ""}`} transform={`translate(${p.x},${p.y})`}>
                <circle r={R} fill={p.colour} />
                <text className="initial" textAnchor="middle" dy="7">
                  {n[0]}
                </text>
                <text className="name" textAnchor="middle" y={top ? -R - 10 : R + 20}>
                  {n}
                </text>
                {/* the result sits outside, beyond the name, so the middle stays clear for the payment */}
                <g className="badge" transform={`translate(0,${top ? -R - 40 : R + 46})`}>
                  <rect x="-30" y="-11" width="60" height="22" rx="11" />
                  <text textAnchor="middle" dy="4.5">
                    {even ? "even ✓" : NET[n] > 0 ? `+$${NET[n]}` : `−$${-NET[n]}`}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        <div className="night-controls">
          <button className="btn sm" onClick={() => setSettled(!settled)} aria-pressed={settled}>
            {settled ? "↺ Back to the night" : "Settle up →"}
          </button>
          <span className="faint">Example</span>
        </div>
      </div>
    </div>
  );
}
