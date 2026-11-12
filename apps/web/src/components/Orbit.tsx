import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { AgentSummary } from "@quorum/core";
import { hue } from "./ui.tsx";
import { usd } from "../lib/format.ts";

export interface OrbitEdge {
  from: string;
  to: string;
  /** base units owed from -> to */
  amount: bigint;
  count: number;
}

/**
 * The entity circle: every agent sits on a ring, and every debt between two agents is a
 * chord from the one that owes to the one that is owed. Chords thicken with the amount,
 * a light runs along each in the direction the money will move, and a node that just
 * traded swells. Hover an agent to isolate what it owes and is owed; click to open it.
 */
export function Orbit({ agents, edges, active, centre }: { agents: AgentSummary[]; edges: OrbitEdge[]; active?: Map<string, number>; centre?: { label: string; value: string } }) {
  const [hover, setHover] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const nav = useNavigate();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const S = 640;
  const C = S / 2;
  const R = 232;
  const layout = useMemo(() => {
    const list = [...agents].sort((a, b) => Number(a.agentId) - Number(b.agentId));
    return new Map(
      list.map((a, i) => {
        const angle = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
        return [a.agentId, { a, angle, x: C + Math.cos(angle) * R, y: C + Math.sin(angle) * R }];
      }),
    );
  }, [agents, C]);
  const max = edges.reduce((m, e) => (e.amount > m ? e.amount : m), 1n);
  const dense = agents.length > 16;
  const focus = hover ? layout.get(hover) : null;
  const owed = hover ? edges.filter((e) => e.to === hover).reduce((s, e) => s + e.amount, 0n) : 0n;
  const owes = hover ? edges.filter((e) => e.from === hover).reduce((s, e) => s + e.amount, 0n) : 0n;

  return (
    <div ref={wrap} style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg className="orbit" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`${agents.length} agents and ${edges.length} open debts between them`}>
        <circle className="ring" cx={C} cy={C} r={R} />
        <circle className="ring" cx={C} cy={C} r={R * 0.62} strokeDasharray="2 7" />
        {edges.map((e) => {
          const p = layout.get(e.from);
          const q = layout.get(e.to);
          if (!p || !q) return null;
          // pull the chord towards the centre so parallel debts fan out instead of stacking
          const k = 0.28;
          const mx = C + ((p.x + q.x) / 2 - C) * k;
          const my = C + ((p.y + q.y) / 2 - C) * k;
          const d = `M${p.x.toFixed(1)},${p.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`;
          const weight = 0.8 + (Number((e.amount * 1000n) / max) / 1000) * 3.4;
          const off = hover !== null && e.from !== hover && e.to !== hover;
          const id = `e-${e.from}-${e.to}`;
          return (
            <g key={id} className={off ? "dim" : undefined}>
              <path id={id} className="edge" d={d} strokeWidth={weight} opacity={0.3 + (weight / 4.2) * 0.5} />
              <circle className="pulse" r={1.4 + weight * 0.45}>
                <animateMotion dur={`${2.2 + (Number(e.from) % 5) * 0.35}s`} repeatCount="indefinite" path={d} />
              </circle>
            </g>
          );
        })}
        {[...layout.values()].map(({ a, angle, x, y }) => {
          const recent = active?.get(a.agentId) ?? 0;
          const hot = now - recent < 2_500;
          const r = (dense ? 8 : 11) + (hot ? 4 : 0);
          const off = hover !== null && hover !== a.agentId && !edges.some((e) => (e.from === hover && e.to === a.agentId) || (e.to === hover && e.from === a.agentId));
          const lx = C + Math.cos(angle) * (R + 24);
          const ly = C + Math.sin(angle) * (R + 24);
          const anchor = Math.abs(Math.cos(angle)) < 0.25 ? "middle" : Math.cos(angle) > 0 ? "start" : "end";
          return (
            <g
              key={a.agentId}
              className={`node${off ? " dim" : ""}`}
              tabIndex={0}
              role="link"
              aria-label={`${a.name}, ${a.role}`}
              onMouseEnter={() => setHover(a.agentId)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(a.agentId)}
              onBlur={() => setHover(null)}
              onClick={() => nav(`/agents/${a.agentId}`)}
              onKeyDown={(e) => e.key === "Enter" && nav(`/agents/${a.agentId}`)}
            >
              <circle cx={x} cy={y} r={22} fill="transparent" />
              {hot && <circle cx={x} cy={y} r={r + 7} fill="none" stroke="rgba(233,201,207,.5)" />}
              <circle cx={x} cy={y} r={r} fill={hue(a.agentId)} stroke="rgba(243,240,232,.75)" strokeWidth={1.2} />
              <circle cx={x} cy={y} r={1.6} fill="rgba(42,36,29,.75)" />
              {(!dense || hover === a.agentId) && (
                <text x={lx} y={ly} textAnchor={anchor} dominantBaseline="middle" fontSize={dense ? 12 : 13}>
                  {a.name}
                </text>
              )}
            </g>
          );
        })}
        <g textAnchor="middle" pointerEvents="none">
          <text x={C} y={C - 16} fontSize={11} letterSpacing="2.4" opacity={0.6}>
            {(focus ? focus.a.role : (centre?.label ?? "")).toUpperCase()}
          </text>
          <text x={C} y={C + 20} fontSize={focus ? 30 : 40} fontWeight={500} letterSpacing="-1.4">
            {focus ? focus.a.name : (centre?.value ?? "")}
          </text>
          {focus && (
            <text x={C} y={C + 48} fontSize={13} opacity={0.72}>
              owes {usd(owes, 4)} · is owed {usd(owed, 4)}
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}
