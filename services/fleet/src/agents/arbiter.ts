import type { Hex } from "@quorum/core";
import type { QuorumAgent } from "@quorum/sdk";
import type { Fleet } from "../fleet.ts";
import { PRICES, judgeClaim, type FactCheck } from "./workers.ts";
import { wikiSearch } from "../work/wikipedia.ts";
import { devanagariRatio, keywords, overlap } from "../work/text.ts";
import { audit } from "../work/contracts.ts";
import { contrast } from "../work/design.ts";

interface Evaluation {
  upheld: boolean;
  reasoning: string;
}

/**
 * Arbiter: a staked validator. It judges a disputed job against the job's own spec and
 * the seller's signed delivery, redoing the work independently where it can. Its verdicts
 * are signed, sent to the clearing service and answered on the coordinator contract from its own account.
 */
export function installArbiter(fleet: Fleet, agent: QuorumAgent): void {
  const ruling = new Map<string, Promise<unknown>>();

  const rule = (disputeId: string): Promise<unknown> => {
    const existing = ruling.get(disputeId);
    if (existing) return existing;
    const p = (async () => {
      const d = await agent.client.dispute(disputeId);
      if (d.dispute.status !== "open") return { disputeId, upheld: d.dispute.status === "upheld", reasoning: d.dispute.reasoning, already: true };
      const ev = evaluate(d.job.service, d.spec as { input?: unknown }, d.result, d.dispute.reason);
      const evaluated = await ev;
      await agent.rule(disputeId, d.dispute.disputeHash as Hex, evaluated.upheld, evaluated.reasoning, { onchain: true });
      fleet.touch("arbiter");
      fleet.log("arbiter", `${disputeId}: ${evaluated.upheld ? "UPHELD" : "rejected"} — ${evaluated.reasoning}`);
      return { disputeId, upheld: evaluated.upheld, reasoning: evaluated.reasoning };
    })();
    ruling.set(disputeId, p);
    p.finally(() => setTimeout(() => ruling.delete(disputeId), 60_000));
    return p;
  };

  agent.sell<{ jobId: string; reason: string }, unknown>({
    id: "verdict",
    name: "Dispute verdict",
    description: "Independently re-checks a disputed job against its spec and rules on it. Staked validator.",
    price: PRICES.verdict,
    unit: "dispute",
    tags: ["validation", "arbitration", "dispute"],
    handler: async (input) => {
      // the buyer files the dispute right after buying this job; wait for it to land
      for (let i = 0; i < 40; i++) {
        const j = await agent.client.job(input.jobId).catch(() => null);
        if (j?.dispute) return rule(j.dispute.id);
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`no dispute found for job ${input.jobId}`);
    },
  });

  // disputes assigned without a paid verdict job
  setInterval(async () => {
    try {
      const open = await agent.client.disputes({ status: "open", validator: agent.agentId.toString() });
      for (const d of open) void rule(d.id).catch((err) => fleet.log("arbiter", `ruling ${d.id} failed: ${(err as Error).message}`));
    } catch {
      // clearing temporarily unreachable
    }
  }, 2_500);
}

async function evaluate(service: string, spec: { input?: unknown }, result: unknown, reason: string): Promise<Evaluation> {
  if (result === null || result === undefined) return { upheld: true, reasoning: "The seller's delivery contains no result." };
  const input = (spec?.input ?? {}) as Record<string, unknown>;
  switch (service) {
    case "factcheck": {
      if (!Array.isArray(input.claims)) return evaluateFactCheck(String(input.claim ?? ""), result as Partial<FactCheck>);
      // a batch bought through a tender: it stands only if every check in it stands
      const checks = (result as { checks?: Partial<FactCheck>[] }).checks ?? [];
      if (checks.length !== input.claims.length) return { upheld: true, reasoning: `The delivery covers ${checks.length} of ${input.claims.length} claims.` };
      for (let i = 0; i < checks.length; i++) {
        const e = await evaluateFactCheck(String(input.claims[i]), checks[i]!);
        if (e.upheld) return { upheld: true, reasoning: `Claim ${i + 1} of ${checks.length}: ${e.reasoning}` };
      }
      return { upheld: false, reasoning: `All ${checks.length} checks are sourced and consistent with an independent re-check.` };
    }
    case "translate": {
      const r = result as { translation?: string; to?: string };
      if (!r.translation?.trim()) return { upheld: true, reasoning: "Empty translation." };
      if ((r.to ?? input.to) === "hi" && devanagariRatio(r.translation) < 0.5) {
        return { upheld: true, reasoning: `Requested Hindi, but only ${Math.round(devanagariRatio(r.translation) * 100)}% of the output is in Devanagari script.` };
      }
      return { upheld: false, reasoning: "Translation is non-empty and in the requested script." };
    }
    case "summarize": {
      const r = result as { summary?: string };
      const text = String(input.text ?? "");
      if (!r.summary?.trim()) return { upheld: true, reasoning: "Empty summary." };
      if (r.summary.length > text.length) return { upheld: true, reasoning: "Summary is longer than the source document." };
      const o = overlap(r.summary, text);
      if (o < 0.5) return { upheld: true, reasoning: `Only ${Math.round(o * 100)}% of the summary's content words come from the source.` };
      return { upheld: false, reasoning: `Summary is shorter than the source and ${Math.round(o * 100)}% grounded in it.` };
    }
    case "contract-code": {
      // re-run the audit independently on the delivered source
      const files = (result as { files?: { path: string; content: string }[] }).files ?? [];
      const src = files.find((f) => f.path === "src/lib.rs")?.content;
      if (!src) return { upheld: true, reasoning: "The delivery contains no contract source." };
      const a = audit(src);
      const high = a.findings.filter((f) => f.severity === "high");
      return high.length
        ? { upheld: true, reasoning: `An independent audit of the delivered source finds ${high.length} high-severity issue(s): ${high.map((f) => `${f.message} (line ${f.line})`).join("; ")}.` }
        : { upheld: false, reasoning: `An independent audit finds no high-severity issue (score ${a.score}).` };
    }
    case "palette": {
      const pairs = (result as { pairs?: { fg: string; bg: string; use: string }[] }).pairs ?? [];
      const bad = pairs.filter((p) => contrast(p.fg, p.bg) < (p.use.includes("accent") ? 3 : 4.5));
      return bad.length ? { upheld: true, reasoning: `Recomputed contrast fails for: ${bad.map((p) => p.use).join(", ")}.` } : { upheld: false, reasoning: `All ${pairs.length} pairs meet WCAG AA on recomputation.` };
    }
    case "search": {
      const r = result as { hits?: unknown[] };
      return r.hits?.length ? { upheld: false, reasoning: `Search returned ${r.hits.length} sourced results.` } : { upheld: true, reasoning: "Search returned no results." };
    }
    default:
      return { upheld: false, reasoning: `No specific test for "${service}"; a result was delivered as specified. Buyer's reason: ${reason.slice(0, 120)}` };
  }
}

async function evaluateFactCheck(claim: string, r: Partial<FactCheck>): Promise<Evaluation> {
  const evidence = r.evidence ?? [];
  if (!r.verdict) return { upheld: true, reasoning: "The fact check returned no verdict." };
  const sourced = evidence.filter((e) => /wikipedia\.org\//.test(e.url));
  if (evidence.length > 0 && sourced.length === 0) {
    return { upheld: true, reasoning: `Evidence cites ${evidence.map((e) => new URL(e.url).hostname).join(", ")}, not a verifiable source.` };
  }
  const grounded = evidence.filter((e) => overlap(claim, e.snippet) > 0.2);
  if (r.verdict !== "unverified" && grounded.length === 0) {
    return { upheld: true, reasoning: `Verdict "${r.verdict}" at ${Math.round((r.confidence ?? 0) * 100)}% confidence, but none of the cited evidence mentions the claim.` };
  }
  // independent re-check
  const own = judgeClaim(claim, (await wikiSearch(keywords(claim, 7))).hits);
  if (r.verdict !== "unverified" && own.verdict !== "unverified" && own.verdict !== r.verdict) {
    return { upheld: true, reasoning: `Independent re-check finds the claim ${own.verdict} (${own.method}); the seller said ${r.verdict}.` };
  }
  return { upheld: false, reasoning: `Evidence is sourced and consistent with an independent re-check (${own.verdict}).` };
}
