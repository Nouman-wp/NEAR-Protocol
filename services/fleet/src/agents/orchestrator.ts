import { randomUUID } from "node:crypto";
import { RefusedError, RoundVoidError, type QuorumAgent, type HireResult } from "@quorum/sdk";
import type { Fleet } from "../fleet.ts";
import { FACTCHECK_RESERVE, PRICES, type FactCheck } from "./workers.ts";
import type { SearchHit } from "../work/wikipedia.ts";
import { extractClaims, overlap } from "../work/text.ts";

export interface BriefRecord {
  id: string;
  topic: string;
  languages: string[];
  intentId: string;
  origin: "intent" | "order" | "background" | "scenario";
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  jobs: number;
  refused: number;
  spent: string;
  disputes: { jobId: string; seller: string; reason: string; upheld: boolean | null }[];
  steps: string[];
  result: Brief | null;
  error: string | null;
}

export interface Brief {
  topic: string;
  summary: { en: string; hi?: string[] };
  figure: string | null;
  claims: { claim: string; verdict: string; confidence: number; checkedBy: string; sources: string[] }[];
  sources: { title: string; url: string }[];
  engine: { search: string; translation: string | null };
}

export const TOPICS = [
  "NEAR Protocol",
  "Stablecoin",
  "Chandrayaan-3",
  "Unified Payments Interface",
  "Clearing house (finance)",
  "Monsoon in India",
  "Solar power in India",
  "Indian Railways",
  "Amber",
  "Proof of stake",
  "Bombay Stock Exchange",
  "Taj Mahal",
  "Machine translation",
  "Sharding (database architecture)",
  "Auction theory",
  "Mumbai",
];

export function installOrchestrator(fleet: Fleet, agent: QuorumAgent): void {
  agent.sell<{ topic: string; languages?: string[] }, unknown>({
    id: "brief",
    name: "Research brief",
    description: "A researched, fact-checked brief on any topic, optionally in Hindi too. Hires search, fact-check, summary, chart and translation agents.",
    price: PRICES.brief,
    unit: "brief",
    tags: ["research", "brief", "report"],
    examples: ["{ \"topic\": \"Chandrayaan-3\", \"languages\": [\"en\", \"hi\"] }"],
    handler: async (input, ctx) => {
      const intentId = fleet.standing.get("orchestrator:orders");
      if (!intentId) throw new Error("orchestrator has no standing intent for paid orders");
      const rec = await runBrief(fleet, {
        topic: String(input.topic ?? "").slice(0, 120) || "NEAR Protocol",
        languages: input.languages?.length ? input.languages : ["en"],
        intentId,
        origin: "order",
        parentJobId: ctx.jobId,
      });
      if (!rec.result) throw new Error(rec.error ?? "brief failed");
      return rec.result;
    },
  });
}

/**
 * The orchestrator's plan for one brief. Every step is a paid job between agents:
 *   search (Scout) -> fact checks (one sealed-bid tender on chain for the whole batch; bad
 *   work is disputed through Arbiter and redone at posted prices) -> summary (Scribe, who hires Lens for the figure)
 *   -> Hindi translation (Polyglot, who checks names with Scout).
 */
export async function runBrief(
  fleet: Fleet,
  opts: { topic: string; languages: string[]; intentId: string; origin: BriefRecord["origin"]; parentJobId?: string; minReputation?: number },
): Promise<BriefRecord> {
  const rec: BriefRecord = {
    id: `brief_${randomUUID().slice(0, 8)}`,
    topic: opts.topic,
    languages: opts.languages,
    intentId: opts.intentId,
    origin: opts.origin,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    jobs: 0,
    refused: 0,
    spent: "0",
    disputes: [],
    steps: [],
    result: null,
    error: null,
  };
  fleet.briefs.unshift(rec);
  if (fleet.briefs.length > 40) fleet.briefs.pop();
  let spent = 0n;
  const minRep = opts.minReputation ?? 700;
  const buy = async <T>(service: string, input: unknown, exclude: string[] = []): Promise<HireResult<T> | null> => {
    try {
      const r = await fleet.hire<T>("orchestrator", service, input, { intentId: opts.intentId, parentJobId: opts.parentJobId, minReputation: minRep, exclude });
      rec.jobs++;
      spent += r.price;
      rec.spent = spent.toString();
      return r;
    } catch (err) {
      if (err instanceof RefusedError) rec.refused++;
      rec.steps.push(`${service} failed: ${(err as Error).message}`);
      return null;
    }
  };
  const step = (s: string) => {
    rec.steps.push(s);
    fleet.log("orchestrator", `[${rec.id}] ${s}`);
  };

  try {
    step(`brief on "${opts.topic}" (${opts.languages.join(" + ")})`);

    // 1. research
    const queries = [opts.topic, `${opts.topic} history`, `${opts.topic} significance`];
    const searches = (await Promise.all(queries.map((q) => buy<{ hits: SearchHit[]; source: string }>("search", { query: q })))).filter(Boolean) as HireResult<{
      hits: SearchHit[];
      source: string;
    }>[];
    if (opts.languages.includes("hi")) {
      const hi = await buy<{ hits: SearchHit[]; source: string }>("search", { query: opts.topic, lang: "hi" });
      if (hi) searches.push(hi);
    }
    const hits = searches.flatMap((s) => s.result.hits ?? []);
    if (hits.length === 0) throw new Error("no sources found");
    step(`${searches.length} searches, ${hits.length} sources`);

    // 2. fact checks: one sealed-bid tender for the batch, competing checkers bid per claim
    const claims = extractClaims(hits.filter((h) => /en\.wikipedia/.test(h.url) || !h.url.includes("wikipedia")).map((h) => h.extract ?? h.snippet), 4);
    const checked: Brief["claims"] = [];
    const accept = (claim: string, fc: FactCheck, by: string) => checked.push({ claim, verdict: fc.verdict, confidence: fc.confidence, checkedBy: by, sources: fc.evidence.map((e) => e.url) });
    const disputeJob = async (r: HireResult<unknown>, problem: string): Promise<boolean | null> => {
      step(`fact check by ${r.seller.name} looks wrong (${problem}); disputing`);
      const d = { jobId: r.jobId, seller: r.seller.name, reason: problem, upheld: null as boolean | null };
      rec.disputes.push(d);
      const verdict = await fleet.dispute("orchestrator", r.jobId, problem, opts.intentId).catch((err) => {
        step(`dispute failed: ${(err as Error).message}`);
        return null;
      });
      d.upheld = (verdict as { upheld?: boolean } | null)?.upheld ?? null;
      if (d.upheld) spent -= r.price;
      return d.upheld;
    };
    /** Posted-price fallback for one claim: the cheapest checker above the floor, retrying past bad work. */
    const checkOne = async (claim: string, exclude: string[]) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await buy<FactCheck>("factcheck", { claim }, exclude);
        if (!r) return;
        const problem = badFactCheck(r.result);
        if (!problem || (await disputeJob(r, problem)) === false) return void accept(claim, r.result, r.seller.name);
        exclude.push(r.seller.agentId);
      }
    };
    let redo = claims;
    const exclude: string[] = [];
    if (claims.length > 0) {
      try {
        const t = await fleet.tender<{ checks: FactCheck[] }>(
          "orchestrator",
          "factcheck",
          { claims },
          { quantity: claims.length, reservePrice: FACTCHECK_RESERVE, title: `Fact-check ${claims.length} claim(s) on ${opts.topic}`, intentId: opts.intentId, parentJobId: opts.parentJobId, minReputation: minRep },
        );
        rec.jobs++;
        spent += t.price;
        rec.spent = spent.toString();
        step(`tender #${t.round.id}: ${t.round.bids.length} sealed bid(s), ${t.seller.name} wins at ${t.round.clearing_price} per claim`);
        const checks = t.result?.checks ?? [];
        const problem = checks.length !== claims.length ? "the delivery does not cover every claim" : (checks.map(badFactCheck).find(Boolean) ?? null);
        if (!problem || (await disputeJob(t, problem)) === false) {
          claims.forEach((c, i) => checks[i] && accept(c, checks[i]!, t.seller.name));
          redo = [];
        } else exclude.push(t.seller.agentId);
      } catch (err) {
        if (err instanceof RefusedError) rec.refused++;
        step(err instanceof RoundVoidError ? `tender void (${(err as Error).message}); buying at posted prices` : `tender failed (${(err as Error).message}); buying at posted prices`);
      }
    }
    await Promise.all(redo.map((claim) => checkOne(claim, [...exclude])));
    step(`${checked.length}/${claims.length} claims checked`);

    // 3. summary with a figure (Scribe hires Lens; Lens hires Scribe for the long caption)
    const sourceText = [...checked.filter((c) => c.verdict !== "contradicted").map((c) => c.claim), ...hits.slice(0, 6).map((h) => h.extract ?? h.snippet)].join(" ");
    const figure = {
      title: `Sources per query on ${opts.topic}`,
      unit: "sources",
      points: searches.map((s, i) => ({ label: queries[i] ?? `${opts.topic} (Hindi)`, value: s.result.hits.length })),
      caption: `Each bar counts the sources returned for one research query about ${opts.topic}. Queries cover the topic itself, its history and its significance, plus a Hindi-language search when a Hindi brief was requested. More sources mean more evidence available for fact checking.`,
    };
    const sum = await buy<{ summary: string; figureDescription: string | null }>("summarize", { title: opts.topic, text: sourceText, figure, maxSentences: 4 });
    const summaryEn = sum?.result.summary ?? checked.map((c) => c.claim).join(" ");
    step("summary written");

    // 4. Hindi
    let hi: string[] | undefined;
    let engine: string | null = null;
    if (opts.languages.includes("hi") && summaryEn) {
      const paras = splitParagraphs(summaryEn, 2);
      const ts = await Promise.all(paras.map((p) => buy<{ translation: string; engine: string }>("translate", { text: p, from: "en", to: "hi" })));
      hi = ts.filter(Boolean).map((t) => t!.result.translation);
      engine = ts.find(Boolean)?.result.engine ?? null;
      step(`translated into Hindi (${hi.length} paragraphs, ${engine})`);
    }

    rec.result = {
      topic: opts.topic,
      summary: { en: summaryEn, hi },
      figure: sum?.result.figureDescription ?? null,
      claims: checked,
      sources: dedupe(hits.map((h) => ({ title: h.title, url: h.url }))).slice(0, 8),
      engine: { search: searches[0]?.result.source ?? "wikipedia", translation: engine },
    };
    rec.status = "done";
    step(`done: ${rec.jobs} paid jobs, ${rec.disputes.length} disputes`);
  } catch (err) {
    rec.status = "failed";
    rec.error = (err as Error).message;
    step(`failed: ${rec.error}`);
  } finally {
    rec.finishedAt = Date.now();
  }
  return rec;
}

/** The orchestrator's own quality bar for a fact check before it accepts the work. */
export function badFactCheck(fc: Partial<FactCheck> | null | undefined): string | null {
  if (!fc || !fc.verdict) return "no verdict returned";
  const ev = fc.evidence ?? [];
  if (fc.verdict !== "unverified" && ev.length === 0) return `verdict "${fc.verdict}" with no evidence`;
  const foreign = ev.find((e) => !/wikipedia\.org\//.test(e.url));
  if (foreign) return `evidence from an unverifiable source (${safeHost(foreign.url)})`;
  if ((fc.confidence ?? 0) > 0.95 && ev.every((e) => overlap(fc.claim ?? "", e.snippet) < 0.2)) return "near-certain verdict but the evidence does not mention the claim";
  return null;
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u.slice(0, 40);
  }
}

function splitParagraphs(text: string, n: number): string[] {
  const s = text.split(/(?<=[.!?])\s+/);
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size).join(" "));
  return out.filter((p) => p.trim());
}

function dedupe<T extends { url: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}
