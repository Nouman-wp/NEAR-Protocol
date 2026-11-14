import { formatUnits } from "@yuki/core";

/**
 * Money in base units, rounded for reading: "$12.30", "$0.88", "$0.00144", "$0".
 * A dollar or more reads in cents; from 10 cents to a dollar, two decimals; below that,
 * three significant digits. The exact value is `usdExact` (shown in tooltips).
 * The second argument is ignored and kept so older call sites still compile.
 */
export function usd(units: string | number | bigint | null | undefined, _legacyDecimals?: number): string {
  if (units === null || units === undefined || units === "") return "—";
  const v = BigInt(units);
  if (v === 0n) return "$0";
  const a = v < 0n ? -v : v;
  const n = Number(a) / 1e6;
  let s: string;
  if (n >= 1) s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else if (n >= 0.1) s = n.toFixed(2);
  else s = String(Number(n.toPrecision(3)));
  // toPrecision can produce "1e-6" for the smallest amounts: write them out
  if (s.includes("e")) s = n.toFixed(6).replace(/0+$/, "");
  return `${v < 0n ? "−" : ""}$${s}`;
}

/** The exact amount, every base unit: for tooltips and downloads. */
export function usdExact(units: string | number | bigint | null | undefined): string {
  if (units === null || units === undefined || units === "") return "";
  const v = BigInt(units);
  return `${v < 0n ? "−" : ""}$${formatUnits(v < 0n ? -v : v, 2)}`;
}

/** Signed money for totals: "+$1.20" / "−$0.40" */
export function signedUsd(units: string | number | bigint): string {
  const v = BigInt(units);
  if (v === 0n) return "$0";
  return `${v > 0n ? "+" : "−"}${usd(v < 0n ? -v : v)}`;
}

/** "1 bid", "3 bids"; pass the plural when it is not just +s. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** Readable names for the services agents sell (the API uses short ids). */
const SERVICE_NAMES: Record<string, string> = {
  factcheck: "Fact check",
  "gpu-hour": "GPU hour",
  "api-code": "API code",
  "api-spec": "API design",
  "db-schema": "Database design",
  "contract-code": "Contract code",
  "contract-tests": "Contract tests",
  "contract-audit": "Contract audit",
  copy: "Brand copy",
  logo: "Logo",
  typeset: "Type scale",
  palette: "Colour palette",
  reframe: "Reframe",
  grade: "Colour grade",
  retouch: "Retouch",
  captions: "Captions",
  cut: "Video edit",
  storyboard: "Storyboard",
  search: "Search",
  summarize: "Summary",
  translate: "Translation",
  describe: "Chart reading",
  verdict: "Ruling",
  brief: "Research brief",
  echo: "Echo",
};

export function serviceName(id: string | null | undefined): string {
  if (!id) return "";
  if (SERVICE_NAMES[id]) return SERVICE_NAMES[id]!;
  const words = id.replace(/[-_]+/g, " ");
  return words[0]!.toUpperCase() + words.slice(1);
}

const SMALL = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** Title-case a title people typed ("gateway of india" → "Gateway of India") and trim it. Stored data is untouched. */
export function titleCase(s: string | null | undefined, max = 60): string {
  if (!s) return "";
  const t = s.trim();
  // leave titles that already use capitals alone: they were written that way on purpose
  const out = /[A-Z]/.test(t)
    ? t
    : t
        .split(/\s+/)
        .map((w, i) => (i > 0 && SMALL.has(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
        .join(" ");
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** Plain names for a settle-up's phases. */
export const PHASE_NAMES: Record<string, string> = {
  intake: "Open",
  challenge: "Checking",
  closing: "Adding up",
  settling: "Paying",
  sealed: "Done",
};

/** Plain names for statuses the API reports. */
export const STATUS_NAMES: Record<string, string> = {
  sealed: "Done",
  settled: "Paid",
  recorded: "Paid",
  Closed: "Done",
  closed: "Done",
  paid: "Paid",
  delivered: "Delivered",
  active: "Active",
  rejected: "Rejected",
  netted: "Settled up",
  intake: "Open",
  Open: "Open",
  open: "Open",
  committing: "Taking bids",
  revealing: "Opening bids",
  joining: "Taking buyers",
  closing: "Adding up",
  settling: "Paying",
  challenge: "Checking",
  submitted: "Sent",
  accepted: "Accepted",
  quoted: "Quoted",
  awaiting_payment: "Waiting to pay",
  owes: "Owes",
  disputed: "Complaint open",
  held_out: "Held back",
  planned: "Planned",
  Void: "Cancelled",
  void: "Cancelled",
  defaulted: "Didn't pay",
  failed: "Failed",
  voided: "Cancelled",
  upheld: "Complaint accepted",
  refused: "Refused",
  retired: "Retired",
  done: "Delivered",
  forming: "Hiring",
  working: "Working",
};

export const statusName = (s: string) => STATUS_NAMES[s] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

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

/** Some agent descriptions were written next to another agent ("A second honest fact checker"): make them stand alone. */
export const standalone = (d: string) => d.replace(/^A second (\w)/, (_, c: string) => `${/[aeiou]/i.test(c) ? "An" : "A"} ${c}`);

/** Trust score out of 100: "90/100". */
export function trust(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${Math.round(n / 10)}/100`;
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
