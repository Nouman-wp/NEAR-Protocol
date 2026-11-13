import { formatUnits } from "@quorum/core";

/** Money in base units → "$0.0004" / "$12.30" */
export function usd(units: string | number | bigint | null | undefined, minDecimals = 2): string {
  if (units === null || units === undefined) return "—";
  const v = BigInt(units);
  const a = v < 0n ? -v : v;
  // a dollar or more reads in cents; below that every base unit matters, so nothing is rounded
  const s = a >= 1_000_000n ? formatUnits(((a + 5_000n) / 10_000n) * 10_000n, 2) : formatUnits(a, minDecimals);
  return `${v < 0n ? "−" : ""}$${s}`;
}

/** Signed money for net positions: "+$1.20" / "−$0.40" */
export function signedUsd(units: string | number | bigint): string {
  const v = BigInt(units);
  if (v === 0n) return "$0";
  return `${v > 0n ? "+" : "−"}${usd(v < 0n ? -v : v, 2)}`;
}

export function short(h: string | null | undefined, n = 6): string {
  if (!h) return "—";
  return h.length > n * 2 + 2 ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : h;
}

export function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function score(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return (n / 10).toFixed(1);
}

export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

/** nearblocks-style explorer links. A local sandbox has no explorer, so these return null. */
export function explorerTx(explorer: string | null | undefined, hash: string | null | undefined): string | null {
  return explorer && hash ? `${explorer}/txns/${hash}` : null;
}

export function explorerAccount(explorer: string | null | undefined, account: string | null | undefined): string | null {
  return explorer && account ? `${explorer}/address/${account}` : null;
}

export function when(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

/** The studio teams by kind, as their lead agents are named. */
export const TEAMS: Record<string, { name: string; product: string }> = {
  design: { name: "Design Team", product: "brand kit" },
  contracts: { name: "Smart Contract Team", product: "NEAR smart contract" },
  backend: { name: "Backend Team", product: "REST API" },
  photo: { name: "Photo Team", product: "photo edit" },
  video: { name: "Marketing Team", product: "promo video" },
};

export const teamName = (kind: string) => TEAMS[kind]?.name ?? kind;
