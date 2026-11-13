#!/usr/bin/env node
/**
 * Quorum MCP server. Gives any MCP client a Quorum buyer agent of its own:
 *
 *   find_agent      search the registry by capability, price and reputation
 *   get_quote       ask an agent for a signed, binding quote
 *   hire_agent      buy a job at the posted price: quote -> signed IOU -> verified delivery
 *   tender_job      put a job out to a sealed-bid round on chain and hire whoever wins it
 *   list_rounds     open and recent rounds: tenders and group buys
 *   join_group_buy  add this agent's demand to an open group buy
 *   check_balance   collateral, spending money inside the verifier, intent budget, open debts
 *   get_job         the evidence chain of a job
 *
 * Identity: QUORUM_ACCOUNT_ID + QUORUM_SECRET_KEY + QUORUM_INTENT_ID if you operate your own
 * agent, otherwise a guest session from the swarm: a fresh key, its own sub-account,
 * registered on chain, with 1 tUSDC of collateral, 1 tUSDC inside the verifier and a capped
 * intent. The guest is cached in ~/.quorum/guest-<network>.json so restarts reuse it.
 *
 * stdout is the MCP channel: everything human-readable goes to stderr.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUnits, usd, type RoundView } from "@quorum/core";
import { QuorumAgent, RefusedError, RoundVoidError } from "@quorum/sdk";

const API = (process.env.QUORUM_API ?? "http://localhost:8787").replace(/\/+$/, "");
const FLEET = (process.env.QUORUM_FLEET ?? "http://localhost:8788").replace(/\/+$/, "");
const WEB = (process.env.QUORUM_WEB ?? "http://localhost:5173").replace(/\/+$/, "");
const log = (...a: unknown[]) => console.error("[quorum-mcp]", ...a);

interface Session {
  accountId: string;
  secretKey: string;
  agentId: string;
  intentId: string;
}

async function session(network: string): Promise<Session> {
  const e = process.env;
  if (e.QUORUM_ACCOUNT_ID && e.QUORUM_SECRET_KEY && e.QUORUM_INTENT_ID) {
    return { accountId: e.QUORUM_ACCOUNT_ID, secretKey: e.QUORUM_SECRET_KEY, agentId: e.QUORUM_AGENT_ID ?? "", intentId: e.QUORUM_INTENT_ID };
  }
  const dir = join(homedir(), ".quorum");
  const file = join(dir, `guest-${network}.json`);
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf8")) as Session & { api?: string };
    const intent = await fetch(`${API}/v1/intents/${s.intentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (s.api === API && (intent as { intent?: { status?: string } } | null)?.intent?.status === "active") return s;
    if (s.api === API && s.agentId) {
      // same agent and account, new spending intent
      const r = await fetch(`${FLEET}/guest/renew`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: s.agentId }) }).catch(() => null);
      const body = r ? ((await r.json().catch(() => ({}))) as { intentId?: string }) : {};
      if (r?.ok && body.intentId) {
        const renewed = { ...s, intentId: body.intentId };
        writeFileSync(file, JSON.stringify(renewed, null, 2));
        log(`guest agent #${s.agentId} renewed`);
        return renewed;
      }
    }
    // never lose a key: keep the old session next to the new one
    writeFileSync(join(dir, `guest-${network}-${s.agentId || "old"}-${Date.now()}.json`), readFileSync(file, "utf8"));
  }
  log("requesting a guest session from the swarm…");
  const res = await fetch(`${FLEET}/guest/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = (await res.json()) as Session & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `guest session failed (${res.status})`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...body, api: API }, null, 2));
  log(`guest agent #${body.agentId} ready as ${body.accountId}`);
  return body;
}

const text = (t: string, structured?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});

/** A network blip at startup should not take the server down: retry a few times first. */
async function retry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log(`${what} failed (${(err as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 1_500 * i));
    }
  }
}

const money = (units: string | bigint, d = 4) => `$${formatUnits(BigInt(units), d)}`;

function roundLine(r: RoundView): string {
  const what = r.kind === "GroupBuy" ? `group buy, ${r.demand.length} buyers, ${r.demand.reduce((n, d) => n + d.quantity, 0)} units` : "tender";
  const result = r.status === "Closed" ? `won by #${r.winner} at ${money(r.clearingPrice!)} per unit` : r.status === "Void" ? `void: ${r.voidReason}` : `${r.phase}, ${r.bids.length} sealed bid(s)`;
  return `#${r.id} ${r.title || r.service} (${r.service}, ${what}, reserve ${money(r.reservePrice)}): ${result}`;
}

async function main() {
  const cfg = await retry("reading the clearing config", async () => {
    const r = await fetch(`${API}/v1/config`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { network: { key: string; name: string } };
  });
  const s = await retry("opening the session", () => session(cfg.network.key));
  const agent = await retry("connecting the agent", () =>
    QuorumAgent.connect({ accountId: s.accountId, secretKey: s.secretKey, clearingUrl: API, agentId: s.agentId ? BigInt(s.agentId) : undefined }),
  );
  log(`acting as agent #${agent.agentId} (${agent.accountId}) on ${cfg.network.name}`);

  // the guest is a buyer, so it will owe money at epoch close: it signs its own settlement
  setInterval(() => {
    agent
      .settleDebts()
      .then((r) => r.settled.forEach((id) => log(`signed the NEAR Intents transfers for ${id}`)))
      .catch(() => undefined);
  }, 4_000);

  const server = new McpServer({ name: "quorum", version: "0.1.0" });

  const resolve = async (who: string) => {
    const list = await agent.client.agents();
    const a = list.find((x) => x.agentId === who || x.slug === who.toLowerCase() || x.name.toLowerCase() === who.toLowerCase() || x.account === who);
    if (!a) throw new Error(`no agent called "${who}"; use find_agent first`);
    return a;
  };

  server.registerTool(
    "find_agent",
    {
      title: "Find Quorum agents",
      description:
        "Search the Quorum agent registry. Filter by capability (e.g. search, factcheck, translate, summarize, describe, brief, verdict, gpu-hour), maximum price in USD per call, and minimum reputation (0-100).",
      inputSchema: {
        capability: z.string().optional().describe("service id or tag, e.g. 'brief' or 'factcheck'"),
        query: z.string().optional().describe("free text over names and descriptions"),
        maxPriceUsd: z.number().optional(),
        minReputation: z.number().min(0).max(100).optional(),
      },
    },
    async ({ capability, query, maxPriceUsd, minReputation }) => {
      const list = await agent.client.agents({
        capability,
        q: query,
        maxPrice: maxPriceUsd !== undefined ? usd(maxPriceUsd.toFixed(6)).toString() : undefined,
        minReputation: minReputation !== undefined ? Math.round(minReputation * 10) : undefined,
      });
      const rows = list
        .filter((a) => a.status === "active" && a.services.length)
        .map((a) => ({
          agentId: a.agentId,
          account: a.account,
          name: a.name,
          reputation: Number((a.reputation / 10).toFixed(1)),
          services: a.services.map((x) => ({ id: x.id, name: x.name, priceUsd: formatUnits(BigInt(x.price), 4), unit: x.unit })),
          description: a.description,
        }));
      const lines = rows.map((r) => `#${r.agentId} ${r.name} (${r.account}, rep ${r.reputation}): ${r.services.map((x) => `${x.id} $${x.priceUsd}/${x.unit}`).join(", ")}. ${r.description}`);
      return text(lines.length ? lines.join("\n") : "No agents match.", { agents: rows });
    },
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get a signed quote",
      description: "Ask an agent for a signed, binding quote for a job at its posted price. Nothing is paid.",
      inputSchema: {
        agent: z.string().describe("agent id, slug, name or NEAR account"),
        service: z.string(),
        input: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('job input, e.g. {"query": "..."} for search or {"topic": "..."} for brief'),
      },
    },
    async ({ agent: who, service, input }) => {
      const a = await resolve(who);
      if (!a.services.some((x) => x.id === service)) throw new Error(`${a.name} does not sell "${service}"`);
      const res = await fetch(a.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: { message: { role: "user", messageId: String(Date.now()), parts: [{ kind: "data", data: { quorum: { action: "quote", buyer: agent.agentId.toString(), service, input: normalise(service, input) } } }] } },
        }),
      });
      const body = (await res.json()) as { result?: { parts?: { data?: { quorum?: { quote: Record<string, string> } } }[] }; error?: { message: string } };
      if (body.error) throw new Error(body.error.message);
      const q = body.result?.parts?.[0]?.data?.quorum?.quote as { price: string; expiry: string; jobHash: string } | undefined;
      if (!q) throw new Error("no quote returned");
      return text(`${a.name} quotes ${money(q.price)} for ${service}, valid until ${new Date(Number(q.expiry) * 1000).toLocaleTimeString()}. Signed by the seller; hire_agent pays exactly this.`, {
        agent: a.name,
        priceUsd: formatUnits(BigInt(q.price), 4),
        expiry: Number(q.expiry),
        jobHash: q.jobHash,
      });
    },
  );

  server.registerTool(
    "hire_agent",
    {
      title: "Hire a Quorum agent",
      description:
        'Hire an agent for one job at its posted price. Gets a signed quote, signs an IOU under this session\'s spending intent, has the seller do the work and verifies its signed delivery. The debt is netted at the end of the epoch and settled through NEAR Intents. Example: agent "orchestrator", service "brief", input {"topic": "Chandrayaan-3"}.',
      inputSchema: {
        agent: z.string().describe("agent id, slug, name or NEAR account"),
        service: z.string(),
        input: z.union([z.string(), z.record(z.string(), z.unknown())]),
        maxPriceUsd: z.number().optional().describe("refuse if the quote is higher"),
      },
    },
    async ({ agent: who, service, input, maxPriceUsd }) => {
      const a = await resolve(who);
      try {
        const r = await agent.hire(a, service, normalise(service, input), { intentId: s.intentId, maxPrice: maxPriceUsd !== undefined ? usd(maxPriceUsd.toFixed(6)) : undefined });
        const link = `${WEB}/jobs/${r.jobId}`;
        const out = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
        return text(`Hired ${a.name} for ${service} at ${money(r.price)} (epoch ${r.epoch}). Evidence: ${link}\n\n${out.slice(0, 12_000)}`, {
          jobId: r.jobId,
          epoch: r.epoch,
          priceUsd: formatUnits(r.price, 4),
          evidence: link,
          result: r.result as Record<string, unknown>,
        });
      } catch (err) {
        if (err instanceof RefusedError) return text(`Refused by the clearing service: ${err.reason}`);
        throw err;
      }
    },
  );

  const STUDIOS: Record<string, { slug: string; service: string; example: Record<string, unknown> }> = {
    design: { slug: "atelier", service: "design-studio", example: { name: "Monsoon Coffee", vibe: "warm", tagline: "Brewed slow, served warm" } },
    contracts: { slug: "forge", service: "contract-studio", example: { name: "Bazaar Escrow", template: "escrow", param: 100 } },
    backend: { slug: "foundry", service: "backend-studio", example: { resource: "booking" } },
    photo: { slug: "darkroom", service: "photo-studio", example: { topic: "Taj Mahal", look: "film" } },
    video: { slug: "cutroom", service: "video-studio", example: { topic: "Monsoon of South Asia", shots: 4, look: "film" } },
  };
  server.registerTool(
    "hire_studio",
    {
      title: "Hire a Quorum team",
      description:
        "Hire a team of agents for a finished product. The team lead puts every role out to a sealed-bid tender on chain, the winning freelancer agents do the work, the lead checks it and delivers. Takes one to two minutes. Teams: design = Design Team (brand kit with AI-written copy: {name, vibe: warm|cool|earthy|neon|pastel|mono, tagline}), contracts = Smart Contract Team (NEAR contract: {name, template: escrow|token|voting, param}), backend = Backend Team (REST API: {resource, fields?, auth?}), photo = Photo Team (photo edit: {topic or imageUrl, look: film|noir|teal-orange|vintage|vivid}), video = Marketing Team (promo clip: {topic, shots, look}).",
      inputSchema: {
        studio: z.enum(["design", "contracts", "backend", "photo", "video"]),
        brief: z.record(z.string(), z.unknown()).optional().describe("what to make; an example brief is used if omitted"),
      },
    },
    async ({ studio, brief }) => {
      const def = STUDIOS[studio]!;
      const a = await resolve(def.slug);
      try {
        const r = await agent.hire(a, def.service, brief && Object.keys(brief).length ? brief : def.example, { intentId: s.intentId });
        const out = r.result as { job?: string; team?: { role: string; agent: string | null; price: string | null; round: number | null }[]; deliverables?: Record<string, unknown> };
        const page = out.job ? `${WEB}/studios/${out.job}` : `${WEB}/jobs/${r.jobId}`;
        const team = (out.team ?? []).map((t) => `- ${t.role}: ${t.agent ?? "?"}${t.round ? ` (round #${t.round})` : ""}${t.price ? ` at ${money(BigInt(t.price))}` : ""}`).join("\n");
        return text(`${a.name} delivered for ${money(r.price)} (epoch ${r.epoch}). Its team:\n${team}\n\nDeliverables: ${page}\n\n${JSON.stringify(out.deliverables ?? {}, null, 2).slice(0, 10_000)}`, {
          jobId: r.jobId,
          page,
          priceUsd: formatUnits(r.price, 4),
          team: out.team ?? [],
          deliverables: out.deliverables ?? {},
        });
      } catch (err) {
        if (err instanceof RefusedError) return text(`Refused by the clearing service: ${err.reason}`);
        throw err;
      }
    },
  );

  server.registerTool(
    "tender_job",
    {
      title: "Tender a job in a sealed-bid round",
      description:
        'Put one job out to competing sellers instead of taking a posted price. Opens a sealed-bid round on the coordinator contract from this agent\'s own NEAR account, waits while sellers commit and reveal hidden bids (about 15 seconds on a local sandbox, longer on testnet), then hires whoever the contract says won, at the clearing price. Example: service "factcheck", input {"claims": ["The Taj Mahal is in Agra."]}, reservePriceUsd 0.0025.',
      inputSchema: {
        service: z.string().describe("what to buy, e.g. factcheck"),
        input: z.union([z.string(), z.record(z.string(), z.unknown())]),
        reservePriceUsd: z.number().positive().describe("the most you pay per unit; bids above it do not count"),
        quantity: z.number().int().positive().optional().describe("units, e.g. the number of claims; default 1"),
        secondPrice: z.boolean().optional().describe("pay the lowest losing bid instead of the winning one (default true)"),
      },
    },
    async ({ service, input, reservePriceUsd, quantity, secondPrice }) => {
      try {
        const r = await agent.tender(service, normalise(service, input), {
          intentId: s.intentId,
          reservePrice: usd(reservePriceUsd.toFixed(6)),
          quantity: quantity ?? 1,
          pricing: secondPrice === false ? "FirstPrice" : "SecondPrice",
          title: `${service} tender from an MCP client`,
        });
        const out = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
        return text(
          `Round #${r.round.id}: ${r.round.bids.length} sealed bid(s); ${r.seller.name} won at ${money(r.round.clearing_price)} per unit, ${money(r.price)} in all. Round: ${WEB}/rounds/${r.round.id} · evidence: ${WEB}/jobs/${r.jobId}\n\n${out.slice(0, 12_000)}`,
          { roundId: r.round.id, winner: r.seller.name, clearingPriceUsd: formatUnits(BigInt(r.round.clearing_price), 4), jobId: r.jobId, result: r.result as Record<string, unknown> },
        );
      } catch (err) {
        if (err instanceof RoundVoidError) return text(`${err.message}. Try a higher reservePriceUsd, or hire_agent at a posted price.`);
        if (err instanceof RefusedError) return text(`Refused by the clearing service: ${err.reason}`);
        throw err;
      }
    },
  );

  server.registerTool(
    "list_rounds",
    {
      title: "List sealed-bid rounds",
      description: "Open and recent rounds on the coordinator contract: tenders and group buys, their bids and results.",
      inputSchema: { status: z.enum(["Open", "Closed", "Void"]).optional(), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ status, limit }) => {
      const rounds = await agent.client.rounds({ status, limit: limit ?? 12 });
      return text(rounds.length ? rounds.map(roundLine).join("\n") : "No rounds match.", { rounds: rounds.map((r) => ({ id: r.id, kind: r.kind, service: r.service, phase: r.phase, winner: r.winner, clearingPrice: r.clearingPrice })) });
    },
  );

  server.registerTool(
    "join_group_buy",
    {
      title: "Join a group buy",
      description:
        "Add this agent's demand to an open group buy, from its own NEAR account, before the join window closes. If the round clears at or under maxPriceUsd, this agent buys quantity units from the winner and pays only quantity x clearing price.",
      inputSchema: { roundId: z.number().int().positive(), quantity: z.number().int().positive(), maxPriceUsd: z.number().positive() },
    },
    async ({ roundId, quantity, maxPriceUsd }) => {
      const r = await agent.joinRound(roundId, quantity, usd(maxPriceUsd.toFixed(6)));
      void agent.client.refreshRound(roundId).catch(() => undefined);
      // buy the allocation once the round closes, so the share lands in this agent's epoch
      void (async () => {
        try {
          const round = await agent.awaitRound(roundId);
          if (round.allocations.some((a) => BigInt(a.buyer) === agent.agentId)) {
            await agent.hireRoundWinner(round, { hours: quantity }, { intentId: s.intentId });
            log(`bought ${quantity} unit(s) in round #${roundId}`);
          } else log(`round #${roundId} closed ${round.status === "Closed" ? "above this agent's limit" : "void"}`);
        } catch (err) {
          log(`round #${roundId}: ${(err as Error).message}`);
        }
      })();
      return text(`Joined round #${roundId} for ${quantity} unit(s) at up to $${maxPriceUsd} each (tx ${r.hash}). When it closes this agent buys its share from the winner automatically. Watch it at ${WEB}/rounds/${roundId}.`);
    },
  );

  server.registerTool(
    "check_balance",
    {
      title: "Check balance",
      description: "This session's collateral, spending money inside the NEAR Intents verifier, open obligations, remaining intent budget and debts awaiting settlement.",
      inputSchema: {},
    },
    async () => {
      const [summary, intent, pending, spendable] = await Promise.all([
        agent.client.agent(agent.agentId.toString()),
        fetch(`${API}/v1/intents/${s.intentId}`).then((r) => r.json()) as Promise<{ intent: { budget: string; spent: string; status: string } }>,
        agent.client.settlements({ agentId: agent.agentId.toString() }),
        agent.intentsBalance(),
      ]);
      const c = summary.agent.collateral;
      const open = pending.filter((p) => p.status !== "recorded" && p.status !== "defaulted");
      const data = {
        agentId: agent.agentId.toString(),
        account: agent.accountId,
        spendableUsd: formatUnits(spendable, 4),
        collateralUsd: formatUnits(BigInt(c.total), 2),
        openObligationsUsd: formatUnits(BigInt(c.exposure), 4),
        headroomUsd: formatUnits(BigInt(c.headroom), 4),
        intent: { status: intent.intent.status, budgetUsd: formatUnits(BigInt(intent.intent.budget), 2), spentUsd: formatUnits(BigInt(intent.intent.spent), 4) },
        pendingSettlements: open.map((p) => ({ epoch: p.epoch, amountUsd: formatUnits(BigInt(p.amount), 4), status: p.status })),
      };
      return text(
        `Agent #${data.agentId} (${data.account}): $${data.spendableUsd} inside the verifier, collateral $${data.collateralUsd}, open obligations $${data.openObligationsUsd}, headroom $${data.headroomUsd}. Intent ${data.intent.status}: $${data.intent.spentUsd} of $${data.intent.budgetUsd} spent. ${open.length} settlement(s) pending.`,
        data,
      );
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get a job's evidence",
      description: "Status of a job and its chain of evidence: round, quote, IOU, delivery, dispute, epoch, settlement.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      const j = (await fetch(`${API}/v1/jobs/${jobId}`).then((r) => r.json())) as Record<string, unknown>;
      return text(`${WEB}/jobs/${jobId}\n${JSON.stringify(j, null, 2).slice(0, 8000)}`);
    },
  );

  await server.connect(new StdioServerTransport());
  log("ready on stdio");
}

/** Accept plain strings for the common services. */
function normalise(service: string, input: string | Record<string, unknown>): unknown {
  if (typeof input !== "string") return input;
  if (service === "search") return { query: input };
  if (service === "factcheck") return { claim: input };
  if (service === "brief") return { topic: input, languages: /hindi/i.test(input) ? ["en", "hi"] : ["en"] };
  if (service === "translate") return { text: input, to: "hi" };
  if (service === "summarize") return { title: "Document", text: input };
  if (service === "gpu-hour") return { hours: Number(input) || 1 };
  return input;
}

main().catch((err) => {
  log(err instanceof Error ? err.message : err);
  process.exit(1);
});
