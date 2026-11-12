import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { ONE_NEAR, formatUnits, randomKeyPair, type AgentSummary as Summary } from "@quorum/core";
import { ClearingClient, QuorumAgent, Operator, RoundVoidError, end, serveAgents, type AgentProfile, type ChainRound, type ClearingConfig, type HireResult } from "@quorum/sdk";
import { agentKey, type FleetConfig } from "./config.ts";
import { installArbiter } from "./agents/arbiter.ts";
import { installOrchestrator, runBrief, TOPICS, type BriefRecord } from "./agents/orchestrator.ts";
import { installLens, installPolyglot, installRogue, installScout, installScribe, installSentinel, installVerifier } from "./agents/workers.ts";
import { Market, marketMembers } from "./market.ts";
import { FREELANCERS, ROLES, STUDIOS, briefFor, studioMembers, type StudioJob, type StudioKind } from "./agents/studios.ts";
import { MediaStore } from "./work/media.ts";
import { UserAgents } from "./agents/users.ts";

export interface FleetMember {
  /** also the name of the agent's sub-account: `<slug>.<root>` */
  slug: string;
  group: "research" | "market" | "studios";
  profile: Omit<AgentProfile, "baseUrl" | "slug">;
  install: (fleet: Fleet, agent: QuorumAgent) => void;
  /** standing intents: what this agent may buy on its own, signed by its operator */
  buys: { key: string; goal: string; services: string[]; budget: bigint; perJobCap: bigint; minRep: number }[];
}

const USD = (n: number) => BigInt(Math.round(n * 1e6));

export const RESEARCH: FleetMember[] = [
  {
    slug: "orchestrator",
    group: "research",
    profile: { name: "Orchestrator", role: "Research lead", description: "Turns a goal into a researched, fact-checked brief by hiring the rest of the swarm. Puts its fact checks out to sealed-bid tender. Sells finished briefs.", fleet: true },
    install: installOrchestrator,
    buys: [
      { key: "orders", goal: "[standing] Fulfil paid brief orders", services: [], budget: USD(50), perJobCap: USD(0.05), minRep: 700 },
      { key: "background", goal: "[standing] Background research briefs", services: [], budget: USD(50), perJobCap: USD(0.05), minRep: 700 },
    ],
  },
  {
    slug: "scout",
    group: "research",
    profile: { name: "Scout", role: "Search", description: "Searches Wikipedia and returns sourced snippets per query. Buys translations for non-English searches.", fleet: true },
    install: installScout,
    buys: [{ key: "main", goal: "[standing] Translate non-English search results", services: ["translate"], budget: USD(10), perJobCap: USD(0.01), minRep: 600 }],
  },
  {
    slug: "verifier",
    group: "research",
    profile: { name: "Verifier", role: "Fact checker", description: "Checks claims against sources it buys from search agents. Bids its cost plus a fixed margin in fact-check tenders.", fleet: true },
    install: installVerifier,
    buys: [{ key: "main", goal: "[standing] Buy search results for fact checks", services: ["search"], budget: USD(20), perJobCap: USD(0.005), minRep: 600 }],
  },
  {
    slug: "sentinel",
    group: "research",
    profile: { name: "Sentinel", role: "Fact checker", description: "A second honest fact checker. Follows past clearing prices and bids just under them in fact-check tenders.", fleet: true },
    install: installSentinel,
    buys: [{ key: "main", goal: "[standing] Buy search results for fact checks", services: ["search"], budget: USD(20), perJobCap: USD(0.005), minRep: 600 }],
  },
  {
    slug: "polyglot",
    group: "research",
    profile: { name: "Polyglot", role: "Translator", description: "Translates paragraphs between English and Hindi, confirming names with a search agent.", fleet: true },
    install: installPolyglot,
    buys: [{ key: "main", goal: "[standing] Look up names before translating", services: ["search"], budget: USD(10), perJobCap: USD(0.005), minRep: 600 }],
  },
  {
    slug: "scribe",
    group: "research",
    profile: { name: "Scribe", role: "Summariser", description: "Writes extractive summaries; buys chart descriptions for documents with figures.", fleet: true },
    install: installScribe,
    buys: [{ key: "main", goal: "[standing] Buy figure descriptions and translations", services: ["describe", "translate"], budget: USD(10), perJobCap: USD(0.01), minRep: 600 }],
  },
  {
    slug: "lens",
    group: "research",
    profile: { name: "Lens", role: "Chart reader", description: "Describes charts and data series in plain words; condenses long captions with a summariser.", fleet: true },
    install: installLens,
    buys: [{ key: "main", goal: "[standing] Condense long captions", services: ["summarize"], budget: USD(10), perJobCap: USD(0.01), minRep: 600 }],
  },
  {
    slug: "arbiter",
    group: "research",
    profile: { name: "Arbiter", role: "Validator", description: "Staked validator. Re-checks disputed jobs independently and rules; answers each validation request on chain from its own account.", validator: true, fleet: true },
    install: installArbiter,
    buys: [],
  },
  {
    slug: "rogue",
    group: "research",
    profile: { name: "Rogue", role: "Fact checker (budget)", description: "Undercuts everyone in fact-check tenders. Deliberately unreliable, so disputes and reputation have something to catch.", fleet: true, organization: "Rogue Ops" },
    install: installRogue,
    buys: [],
  },
];

export interface FleetState {
  paused: boolean;
  background: boolean;
  rogueBadRate: number;
  rogueDiscount: boolean;
  offline: Set<string>;
  scenario: { name: string; startedAt: number; until: number } | null;
}

/**
 * The live swarm. Every agent is its own NEAR sub-account with its own key, collateral
 * and balance inside the NEAR Intents verifier. The research agents hire each other and
 * tender their fact checks; the market agents pool demand in group buys. The root account
 * is every agent's operator: it creates the accounts, funds them and signs the standing
 * intents that bound what each agent may spend.
 */
export class Fleet {
  readonly cfg: FleetConfig;
  readonly agents = new Map<string, QuorumAgent>();
  readonly standing = new Map<string, string>();
  readonly briefs: BriefRecord[] = [];
  readonly studioJobs: StudioJob[] = [];
  readonly media: MediaStore;
  readonly users: UserAgents;
  readonly activity = new Map<string, number>();
  readonly logs: { at: number; slug: string; message: string }[] = [];
  readonly state: FleetState;
  readonly members: FleetMember[];
  client!: ClearingClient;
  clearing!: ClearingConfig;
  operator!: Operator;
  market!: Market;
  private summaries: { at: number; list: Summary[] } | null = null;
  private prices = new Map<string, bigint[]>();
  private handledIntents = new Set<string>();
  private guests = new Map<string, { name: string; account: string }>();
  private guestLog: number[] = [];
  private ready = false;
  private lastFailure = new Map<string, string>();

  constructor(cfg: FleetConfig) {
    this.cfg = cfg;
    this.state = { paused: false, background: cfg.background, rogueBadRate: cfg.rogueBadRate, rogueDiscount: false, offline: new Set(), scenario: null };
    this.members = [...(cfg.research ? RESEARCH : []), ...(cfg.market ? marketMembers(cfg.simBuyers, cfg.simSellers, cfg.simSeed) : []), ...(cfg.studios ? studioMembers() : [])];
    this.media = new MediaStore(join(cfg.dataDir, "media"), cfg.publicUrl);
    this.users = new UserAgents(this);
  }

  log(slug: string, message: string): void {
    const line = { at: Date.now(), slug, message };
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    console.log(`${new Date().toISOString()} [${slug}] ${message}`);
  }

  touch(slug: string): void {
    this.activity.set(slug, Date.now());
  }

  /** Clearing prices of closed rounds for a service, oldest first. Bidding strategies read this. */
  priceHistory(service: string): bigint[] {
    return this.prices.get(service) ?? [];
  }

  notePrice(service: string, price: bigint): void {
    const list = this.prices.get(service) ?? [];
    list.push(price);
    if (list.length > 50) list.shift();
    this.prices.set(service, list);
  }

  // ---------------------------------------------------------------- bootstrap

  async start(): Promise<void> {
    this.client = new ClearingClient(this.cfg.clearingUrl);
    this.clearing = await waitFor(() => this.client.config(), "clearing service");
    const root = this.clearing.deployment.root;
    this.operator = new Operator(this.clearing, root, this.cfg.rootSecretKey, this.cfg.rpcUrl);
    this.market = new Market(this);

    // 1. agents with keys and cards, served before registration so the cards resolve
    for (const m of this.members) {
      const key = agentKey(this.cfg.seed, m.slug);
      const agent = await QuorumAgent.connect({ accountId: `${m.slug}.${root}`, secretKey: key.secretKey, clearingUrl: this.cfg.clearingUrl, rpcUrl: this.cfg.rpcUrl, config: this.clearing, agentId: 0n });
      agent.setProfile({ ...m.profile, slug: m.slug, baseUrl: `${this.cfg.publicUrl}/agents/${m.slug}` });
      // fellow agents are served from this process: no round trip through the public URL
      agent.routes = [[`${this.cfg.publicUrl}/agents/`, `http://127.0.0.1:${this.cfg.port}/agents/`]];
      m.install(this, agent);
      this.agents.set(m.slug, agent);
    }
    await serveAgents([...this.agents.values()], { port: this.cfg.port, extra: (req, res, body) => this.control(req, res, body) });
    this.log("fleet", `serving ${this.agents.size} agents on :${this.cfg.port} (${this.cfg.publicUrl})`);

    // 2. one sub-account per agent, registered from that account, then money
    await this.ensureTokens(USD(200));
    await this.pool(this.members, 6, async (m) => {
      const agent = this.agents.get(m.slug)!;
      await this.operator.ensureSubAccount(m.slug, agent.publicKey, this.cfg.nearTarget);
      agent.agentId = await agent.lookupAgentId();
      const card = `${this.cfg.publicUrl}/agents/${m.slug}/registration.json`;
      if (agent.agentId === 0n) await agent.register(card, root);
      else await agent.ensureUri(card);
      this.log(m.slug, `agent #${agent.agentId} is ${agent.accountId}`);
    });
    await this.fund();

    // 3. standing intents (AP2 mandates) signed by the operator
    await this.ensureStandingIntents();
    for (const s of ["factcheck", "gpu-hour"]) {
      for (const p of await this.client.roundPrices(s).catch(() => [])) this.notePrice(s, BigInt(p.price));
    }

    // agents users launched from the dashboard
    await this.users.startAll();

    // 4. loops
    const fast = this.cfg.network === "local";
    setInterval(() => void this.settleAll(), 3_000);
    setInterval(() => void this.bidLoop(), fast ? 1_000 : 2_000);
    setInterval(() => void this.watchIntents(), 2_500);
    setInterval(() => void this.fund().catch((err) => this.log("fleet", `funding check failed: ${(err as Error).message}`)), 90_000);
    setInterval(() => void this.ensureStandingIntents().catch(() => undefined), 10 * 60_000);
    if (this.cfg.research) {
      setInterval(() => {
        if (!this.state.background || this.state.paused || this.state.scenario) return;
        const intentId = this.standing.get("orchestrator:background");
        if (!intentId) return;
        const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)]!;
        void runBrief(this, { topic, languages: Math.random() < 0.3 ? ["en", "hi"] : ["en"], intentId, origin: "background" });
      }, this.cfg.backgroundIntervalSeconds * 1000);
    }
    if (this.cfg.studios) {
      setInterval(() => {
        if (!this.state.background || this.state.paused || this.studioJobs.some((j) => j.status === "forming" || j.status === "working")) return;
        const s = STUDIOS[Math.floor(Math.random() * STUDIOS.length)]!;
        void this.commission(s.kind, null, "background").catch(() => undefined);
      }, this.cfg.backgroundIntervalSeconds * 2000);
    }
    if (this.cfg.market && this.cfg.simAuto) {
      setInterval(() => {
        if (!this.state.background || this.state.paused || this.market.busy >= 2) return;
        void this.market.runRound();
      }, this.cfg.simIntervalSeconds * 1000);
      setTimeout(() => this.state.background && !this.state.paused && void this.market.runRound(), 3_000);
    }
    this.ready = true;
    this.log("fleet", "ready");
  }

  /** Run `fn` over `items`, a few at a time. One failure is logged and does not stop the rest. */
  private async pool<T extends { slug: string }>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(width, items.length) }, async () => {
        while (next < items.length) {
          const item = items[next++]!;
          try {
            await fn(item);
          } catch (err) {
            this.log(item.slug, `setup step failed: ${(err as Error).message}`);
          }
        }
      }),
    );
  }

  private async fund(): Promise<void> {
    await this.pool(this.members, 6, (m) => this.fundOne(m));
  }

  /** Collateral with the coordinator, spending money inside the verifier, the verifier key, and NEAR for gas. */
  private async fundOne(m: FleetMember): Promise<void> {
    const agent = this.agents.get(m.slug)!;
    if (agent.agentId === 0n) return;
    const buys = m.buys.length > 0;
    // sellers and the validator carry little debt; buyers need real headroom
    const collateral = m.slug === "orchestrator" ? this.cfg.orchestratorCollateral : buys || m.slug === "arbiter" ? this.cfg.collateralTarget : this.cfg.collateralTarget / 5n;
    const spending = buys ? this.cfg.intentsTarget : this.cfg.intentsTarget / 8n;
    // the operator pays for every agent from one token balance: one agent's deposits at a time,
    // so a balance check is still true when the transfer that relied on it goes out
    await this.withMoneyLock(async () => {
      const acc = await this.operator.collateral(agent.agentId);
      const have = await this.operator.intentsBalance(agent.accountId);
      const need = (acc.available < collateral ? collateral - acc.available : 0n) + (have < spending / 2n ? spending - have : 0n);
      if (need > 0n) await this.ensureTokens(need);
      const added = await this.operator.topUpCollateral(agent.agentId, collateral);
      if (added > 0n) this.log(m.slug, `collateral topped up by ${formatUnits(added)} USDC`);
      if (have < spending / 2n) {
        await this.operator.depositToIntents(agent.accountId, spending - have);
        this.log(m.slug, `${formatUnits(spending - have)} USDC deposited into ${this.clearing.deployment.intents}`);
      }
    });
    await agent.ensureIntentsKey();
    // agents that open and close rounds keep more NEAR: each call reserves its prepaid gas up front
    const opensRounds = m.slug === "orchestrator" || (m.group === "studios" && m.buys.length > 0);
    const target = opensRounds ? this.cfg.nearTarget * 4n : this.cfg.nearTarget;
    const have = (await agent.near.rpc.account(agent.accountId).catch(() => null))?.amount ?? 0n;
    const sent = have < (target * 6n) / 10n ? await this.operator.topUpNear(agent.accountId, target).catch(() => 0n) : 0n;
    if (sent > 0n) this.log(m.slug, `gas topped up by ${(Number(sent / (ONE_NEAR / 1000n)) / 1000).toFixed(3)} NEAR`);
  }

  /** Collateral, spending money inside the verifier and gas for a user's agent, paid by the operator. */
  async fundUserAgent(agent: QuorumAgent, collateral: bigint, spending: bigint): Promise<void> {
    await this.withMoneyLock(async () => {
      await this.ensureTokens(collateral + spending);
      await this.operator.topUpCollateral(agent.agentId, collateral);
      await this.operator.topUpIntents(agent.accountId, spending);
    });
    await this.operator.topUpNear(agent.accountId, this.cfg.nearTarget).catch(() => 0n);
  }

  private moneyLock: Promise<unknown> = Promise.resolve();

  private withMoneyLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.moneyLock.then(fn, fn);
    this.moneyLock = next.catch(() => undefined);
    return next;
  }

  /** Make sure the operator holds at least `need` tokens: from the faucet on test deployments. */
  private async ensureTokens(need: bigint): Promise<void> {
    const bal = await this.operator.tokenBalance();
    if (bal >= need) return;
    if (this.clearing.deployment.mockToken) await this.operator.mintTestTokens(this.operator.accountId, need - bal + USD(500));
    else this.log("fleet", `operator holds ${formatUnits(bal)} of the settlement token and needs ${formatUnits(need)}`);
  }

  private async ensureStandingIntents(): Promise<void> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const m of this.members) {
      if (m.buys.length === 0) continue;
      const agent = this.agents.get(m.slug)!;
      if (agent.agentId === 0n) continue;
      const existing = await this.client.intents({ buyer: agent.agentId.toString() });
      for (const b of m.buys) {
        const reuse = existing.find((i) => i.goal === b.goal && i.status === "active" && BigInt(i.budget) - BigInt(i.spent) > b.budget / 5n && i.deadline > Number(now) + 3600);
        if (reuse) {
          this.standing.set(`${m.slug}:${b.key}`, reuse.id);
          continue;
        }
        const view = await this.operator.authorise(this.client, {
          buyer: agent.agentId,
          goal: b.goal,
          budget: b.budget,
          perJobCap: b.perJobCap,
          minSellerReputation: b.minRep,
          allowedServices: b.services,
          allowedSellers: [],
          notBefore: now - 60n,
          deadline: now + 7n * 86_400n,
          nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
        });
        this.standing.set(`${m.slug}:${b.key}`, view.id);
        this.log(m.slug, `standing intent "${b.goal}" signed by ${this.operator.accountId} (${formatUnits(b.budget)} USDC)`);
      }
    }
  }

  // ---------------------------------------------------------------- trading helpers

  private intentFor(buyer: string, intentId?: string): string {
    const id = intentId ?? this.standing.get(`${buyer}:main`);
    if (!id) throw new Error(`${buyer} has no intent to spend from`);
    return id;
  }

  /** Buy at the posted price from the cheapest seller above the reputation floor. */
  async hire<T = unknown>(
    buyer: string,
    service: string,
    input: unknown,
    opts: { intentId?: string; parentJobId?: string | null; minReputation?: number; exclude?: string[] } = {},
  ): Promise<HireResult<T>> {
    const agent = this.agents.get(buyer);
    if (!agent) throw new Error(`no agent ${buyer}`);
    const intentId = this.intentFor(buyer, opts.intentId);
    const sellers = await agent.findSellers(service, { minReputation: opts.minReputation ?? 600, exclude: opts.exclude });
    const seller = sellers[0];
    if (!seller) throw new Error(`no ${service} seller above reputation ${opts.minReputation ?? 600}`);
    this.touch(buyer);
    return agent.hire<T>(seller, service, input, { intentId, parentJobId: opts.parentJobId ?? null });
  }

  /**
   * Put a job out to sealed-bid tender on chain and buy it from the winner. Throws
   * RoundVoidError when no valid bid arrives, so the caller can fall back to posted prices.
   */
  async tender<T = unknown>(
    buyer: string,
    service: string,
    input: unknown,
    opts: { quantity: number; reservePrice: bigint; title: string; intentId?: string; parentJobId?: string | null; minReputation?: number },
  ): Promise<HireResult<T> & { round: ChainRound }> {
    const agent = this.agents.get(buyer);
    if (!agent) throw new Error(`no agent ${buyer}`);
    const intentId = this.intentFor(buyer, opts.intentId);
    this.touch(buyer);
    const r = await agent.tender<T>(service, input, {
      intentId,
      parentJobId: opts.parentJobId ?? null,
      quantity: opts.quantity,
      reservePrice: opts.reservePrice,
      minReputation: opts.minReputation ?? 0,
      title: opts.title,
      commitMs: this.cfg.commitMs,
      revealMs: this.cfg.revealMs,
    });
    this.notePrice(service, BigInt(r.round.clearing_price));
    return r;
  }

  /** The registry's view of an agent, from a short-lived cache of the full list. */
  async agentSummary(idOrSlug: string): Promise<Summary> {
    if (!this.summaries || Date.now() - this.summaries.at > 15_000) this.summaries = { at: Date.now(), list: await this.client.agents() };
    let a = this.summaries.list.find((x) => x.agentId === idOrSlug || x.slug === idOrSlug);
    if (!a) {
      this.summaries = { at: Date.now(), list: await this.client.agents() };
      a = this.summaries.list.find((x) => x.agentId === idOrSlug || x.slug === idOrSlug);
    }
    if (!a) throw new Error(`no agent ${idOrSlug} in the registry yet`);
    return a;
  }

  async dispute(buyer: string, jobId: string, reason: string, intentId: string): Promise<unknown> {
    const agent = this.agents.get(buyer)!;
    const arbiters = await agent.findSellers("verdict", { minReputation: 500 });
    const r = await agent.dispute(jobId, reason, { intentId, arbiter: arbiters[0] });
    return r.verdict;
  }

  /** Every debtor signs the NEAR Intents transfers for its own net debt. */
  private async settleAll(): Promise<void> {
    await Promise.all(
      [...this.agents.entries()].map(async ([slug, agent]) => {
        if (this.state.offline.has(slug)) return;
        try {
          const r = await agent.settleDebts();
          for (const id of r.settled) this.log(slug, `signed the NEAR Intents transfers for ${id}`);
          for (const f of r.failed) {
            // the same refusal comes back every few seconds until it is fixed: say it once
            if (this.lastFailure.get(f.id) === f.error) continue;
            this.lastFailure.set(f.id, f.error);
            this.log(slug, `settlement ${f.id} failed: ${f.error}`);
          }
        } catch {
          // clearing unreachable; retried next tick
        }
      }),
    );
  }

  /** Show every open round to every agent that bids: commit while the window is open, reveal after. */
  private async bidLoop(): Promise<void> {
    if (!this.ready) return;
    try {
      const open = await this.client.rounds({ status: "Open", limit: 30 });
      for (const round of open) {
        for (const [slug, agent] of this.agents) {
          if (this.state.offline.has(slug)) continue;
          void agent.considerRound(round).then(
            (did) => {
              if (!did) return;
              this.touch(slug);
              this.log(slug, did === "committed" ? `sealed bid committed in round #${round.id}` : `bid revealed in round #${round.id}`);
            },
            (err) => this.log(slug, `round #${round.id}: ${(err as Error).message}`),
          );
        }
      }
    } catch {
      // clearing unreachable; retried next tick
    }
  }

  /** Human-signed intents for the orchestrator start a brief each. */
  private async watchIntents(): Promise<void> {
    const orch = this.agents.get("orchestrator");
    if (!orch || orch.agentId === 0n || this.state.paused) return;
    try {
      const list = await this.client.intents({ buyer: orch.agentId.toString() });
      for (const i of list) {
        if (i.status !== "active" || i.goal.startsWith("[standing]") || this.handledIntents.has(i.id)) continue;
        if (i.createdAt < Date.now() - 10 * 60_000) continue;
        this.handledIntents.add(i.id);
        const languages = /hindi|हिन्दी|हिंदी/i.test(i.goal) ? ["en", "hi"] : ["en"];
        const topic = topicFromGoal(i.goal);
        this.log("orchestrator", `took intent ${i.id.slice(0, 10)}: "${i.goal}"`);
        void runBrief(this, { topic, languages, intentId: i.id, origin: "intent", minReputation: i.minSellerReputation || 700 });
      }
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------- studios

  /** The founder commissions a studio; the studio's lead forms its team and does the work. */
  async commission(kind: StudioKind, brief: Record<string, unknown> | null, origin: string): Promise<{ ok: boolean; message: string }> {
    if (!this.cfg.studios) throw new Error("the studios are not running");
    const studio = STUDIOS.find((s) => s.kind === kind);
    if (!studio) throw new Error(`unknown studio ${kind}`);
    const intentId = this.standing.get("founder:main");
    if (!intentId) throw new Error("the founder has no standing intent yet");
    const input = briefFor(kind, brief);
    this.log("founder", `commissions ${studio.name} (${origin}): ${JSON.stringify(input).slice(0, 120)}`);
    void this.hire("founder", studio.service, input, { intentId, minReputation: 0 }).then(
      (r) => this.log("founder", `${studio.name} delivered job ${r.jobId.slice(0, 10)} for ${formatUnits(r.price)} USDC`),
      (err) => this.log("founder", `${studio.name} commission failed: ${(err as Error).message}`),
    );
    return { ok: true, message: `${studio.name} takes the commission: it puts ${studio.roles.length} roles out to sealed-bid tender, then its team does the work` };
  }

  private studiosView() {
    return {
      running: this.cfg.studios,
      studios: STUDIOS.map((s) => ({
        kind: s.kind,
        slug: s.slug,
        name: s.name,
        service: s.service,
        product: s.product,
        price: s.price.toString(),
        description: s.description,
        examples: s.examples,
        agentId: this.agents.get(s.slug)?.agentId.toString() ?? null,
        roles: s.roles.map((r) => ({
          service: r,
          name: ROLES[r]!.name,
          reserve: ROLES[r]!.reserve.toString(),
          description: ROLES[r]!.description,
          bidders: FREELANCERS.filter((f) => f.skills[r]).map((f) => ({ slug: f.slug, name: f.name, strategy: f.skills[r]![0] })),
        })),
      })),
      freelancers: FREELANCERS.map((f) => ({
        slug: f.slug,
        name: f.name,
        role: f.role,
        description: f.description,
        agentId: this.agents.get(f.slug)?.agentId.toString() ?? null,
        skills: Object.entries(f.skills).map(([service, [strategy]]) => ({ service, strategy })),
      })),
      jobs: this.studioJobs.map((j) => ({ ...j, deliverables: undefined, delivered: j.deliverables !== null })),
    };
  }

  // ---------------------------------------------------------------- scenarios

  async scenario(name: string): Promise<{ ok: boolean; message: string }> {
    const now = Date.now();
    const research = () => {
      const intent = this.standing.get("orchestrator:background");
      if (!this.cfg.research || !intent) throw new Error("the research swarm is not running");
      return intent;
    };
    const needMarket = () => {
      if (!this.cfg.market) throw new Error("the group-buy market is not running");
    };
    switch (name) {
      case "group-buy": {
        needMarket();
        this.state.scenario = { name, startedAt: now, until: now + this.cfg.joinMs + this.cfg.commitMs + this.cfg.revealMs + 8_000 };
        void this.market.runRound();
        return { ok: true, message: "a buyer opens a group buy now: others join, sellers bid sealed, the contract picks the winner" };
      }
      case "swarm-minute": {
        needMarket();
        this.state.scenario = { name, startedAt: now, until: now + 75_000 };
        for (let i = 0; i < 6; i++) setTimeout(() => void this.market.runRound(), i * 9_000);
        if (this.cfg.research) {
          const intent = research();
          const topics = [...TOPICS].sort(() => Math.random() - 0.5);
          for (let i = 0; i < 4; i++) setTimeout(() => void runBrief(this, { topic: topics[i]!, languages: i % 2 ? ["en", "hi"] : ["en"], intentId: intent, origin: "scenario" }), i * 6_000);
        }
        return { ok: true, message: "six group buys and four research briefs over the next minute: dozens of sealed bids, then one settlement batch" };
      }
      case "research-brief": {
        research();
        const view = await this.operator.authorise(this.client, demoIntent(this.agents.get("orchestrator")!.agentId, "Produce a researched, fact-checked brief on Chandrayaan-3 in English and Hindi", 20));
        this.state.scenario = { name, startedAt: now, until: now + 90_000 };
        return { ok: true, message: `intent ${view.id.slice(0, 10)} signed; the orchestrator takes it within seconds` };
      }
      case "busy-minute": {
        const intent = research();
        this.state.scenario = { name, startedAt: now, until: now + 75_000 };
        const topics = [...TOPICS].sort(() => Math.random() - 0.5);
        for (let i = 0; i < 12; i++) {
          const topic = topics[i % topics.length]!;
          setTimeout(() => void runBrief(this, { topic, languages: i % 2 ? ["en", "hi"] : ["en"], intentId: intent, origin: "scenario" }), i * 5_000);
        }
        return { ok: true, message: "12 briefs over the next minute (a few hundred IOUs)" };
      }
      case "rogue-attack": {
        const intent = research();
        this.state.rogueBadRate = 0.95;
        this.state.rogueDiscount = true;
        this.state.scenario = { name, startedAt: now, until: now + 120_000 };
        for (const topic of ["Unified Payments Interface", "Taj Mahal", "Indian Railways"]) void runBrief(this, { topic, languages: ["en"], intentId: intent, origin: "scenario" });
        setTimeout(() => {
          this.state.rogueBadRate = this.cfg.rogueBadRate;
          this.state.rogueDiscount = false;
        }, 120_000);
        return { ok: true, message: "Rogue bids far below everyone and cuts its quality; watch the disputes, then its bids stop counting" };
      }
      case "studio-rush": {
        if (!this.cfg.studios) throw new Error("the studios are not running");
        this.state.scenario = { name, startedAt: now, until: now + 150_000 };
        STUDIOS.forEach((s, i) => setTimeout(() => void this.commission(s.kind, null, "scenario").catch((err) => this.log("founder", (err as Error).message)), i * 4_000));
        return { ok: true, message: "the founder commissions all five studios: each lead tenders its roles, freelancers bid sealed, the winners do the work" };
      }
      case "default-drill": {
        const intent = research();
        this.state.offline.add("orchestrator");
        this.state.scenario = { name, startedAt: now, until: now + 300_000 };
        void runBrief(this, { topic: "Clearing house (finance)", languages: ["en"], intentId: intent, origin: "scenario" });
        setTimeout(() => this.state.offline.delete("orchestrator"), 300_000);
        return { ok: true, message: "the orchestrator stops signing settlements; its next debt is covered from collateral" };
      }
      default:
        return { ok: false, message: `unknown scenario ${name}` };
    }
  }

  reset(): void {
    this.state.paused = false;
    this.state.rogueBadRate = this.cfg.rogueBadRate;
    this.state.rogueDiscount = false;
    this.state.offline.clear();
    this.state.scenario = null;
    void this.fund();
  }

  // ---------------------------------------------------------------- guest onboarding (MCP clients)

  /**
   * A fresh guest agent for an MCP client: a new key, its own sub-account under the root,
   * registered from that account, with small collateral, a little money inside the
   * verifier and a capped intent. Rate limited.
   */
  async guestSession(): Promise<Record<string, string>> {
    this.guestLog = this.guestLog.filter((t) => t > Date.now() - 3_600_000);
    if (this.guestLog.length >= this.cfg.guestSessionsPerHour) throw new Error("guest sessions are rate limited; try again later");
    this.guestLog.push(Date.now());
    const key = randomKeyPair();
    const name = `guest-${key.publicKey.slice(8, 16).toLowerCase().replace(/[^a-z0-9]/g, "0")}`;
    const account = await this.operator.ensureSubAccount(name, key.publicKey, this.cfg.nearTarget);
    this.guests.set(name, { name, account });
    const agent = await QuorumAgent.connect({ accountId: account, secretKey: key.secretKey, clearingUrl: this.cfg.clearingUrl, rpcUrl: this.cfg.rpcUrl, config: this.clearing, agentId: 0n });
    const agentId = await agent.register(`${this.cfg.publicUrl}/guests/${name}/registration.json`, this.operator.accountId);
    await this.ensureTokens(USD(5));
    await this.operator.deposit(agentId, USD(1));
    await this.operator.depositToIntents(account, USD(1));
    await agent.ensureIntentsKey();
    const view = await this.operator.authorise(this.client, guestIntent(agentId));
    this.log("fleet", `guest agent #${agentId} (${account}) onboarded`);
    return { secretKey: key.secretKey, accountId: account, agentId: agentId.toString(), intentId: view.id, clearingUrl: this.cfg.clearingUrl };
  }

  /** A fresh intent for an existing guest whose intent expired or ran out. */
  async renewGuest(agentId: string): Promise<{ intentId: string }> {
    this.guestLog = this.guestLog.filter((t) => t > Date.now() - 3_600_000);
    if (this.guestLog.length >= this.cfg.guestSessionsPerHour * 2) throw new Error("guest renewals are rate limited; try again later");
    const a = await this.agentSummary(agentId);
    if (!a.cardUrl.includes("/guests/") || a.operator !== this.operator.accountId) throw new Error("only guest agents can be renewed");
    this.guestLog.push(Date.now());
    const view = await this.operator.authorise(this.client, guestIntent(BigInt(a.agentId)));
    this.log("fleet", `guest agent #${a.agentId} renewed with intent ${view.id.slice(0, 10)}`);
    return { intentId: view.id };
  }

  // ---------------------------------------------------------------- control API

  private async control(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    if (p.startsWith("/guests/") && p.endsWith("/registration.json")) {
      const name = p.split("/")[2] ?? "";
      end(res, 200, {
        type: "quorum-agent-registration-v1",
        name: `Guest ${name.slice(6)}`,
        description: "A guest buyer agent onboarded from an MCP client.",
        image: "",
        endpoints: [{ name: "nearAccount", endpoint: `near:${this.cfg.network}:${name}.${this.clearing.deployment.root}` }],
        registrations: [],
        supportedTrust: ["reputation"],
        quorum: { slug: name, role: "Guest buyer" },
      });
      return true;
    }
    if (p.startsWith("/users/")) {
      const parts = p.split("/").filter(Boolean); // users, <slug|me>, ...
      if (parts[1] !== "me" && parts[1] !== "dev-account") {
        // a user agent's registration file, A2A card and A2A endpoint, as for the built-in agents
        const agent = this.users.hosted(parts[1]!);
        const sub = parts.slice(2).join("/");
        if (!agent) end(res, 404, { error: "unknown agent" });
        else if (req.method === "GET" && sub === "registration.json") end(res, 200, agent.registration());
        else if (req.method === "GET" && (sub === "" || sub === ".well-known/agent-card.json" || sub === ".well-known/agent.json")) end(res, 200, agent.card());
        else if (req.method === "POST" && sub === "a2a") end(res, 200, await agent.handleA2A(body as never));
        else end(res, 404, { error: "not found" });
        return true;
      }
      if (req.method === "POST" && parts[1] === "dev-account") {
        try {
          end(res, 200, await this.users.devAccount(String((body as { publicKey?: string } | null)?.publicKey ?? "")));
        } catch (err) {
          end(res, 400, { error: (err as Error).message });
        }
        return true;
      }
      if (parts[1] === "me") {
        const s = this.users.session(req.headers.authorization);
        if (!s) {
          end(res, 401, { error: "sign in with your NEAR wallet first" });
          return true;
        }
        const b = (body ?? {}) as { name?: string; studio?: string; brief?: Record<string, unknown> };
        try {
          if (req.method === "GET" && parts[2] === "agents" && parts.length === 3) end(res, 200, this.users.list(s.accountId));
          else if (req.method === "POST" && parts[2] === "agents" && parts.length === 3) end(res, 200, await this.users.create(s.accountId, String(b.name ?? "")));
          else if (req.method === "POST" && parts[2] === "agents" && parts[4] === "hire") end(res, 200, await this.users.hire(s.accountId, parts[3]!, String(b.studio ?? "") as StudioKind, b.brief ?? null));
          else if (req.method === "GET" && parts[2] === "commissions") end(res, 200, this.users.commissions(s.accountId));
          else end(res, 404, { error: "not found" });
        } catch (err) {
          end(res, 400, { error: (err as Error).message });
        }
        return true;
      }
    }
    if (req.method === "GET" && p === "/control/status") {
      end(res, 200, await this.status());
      return true;
    }
    if (req.method === "GET" && p === "/control/briefs") {
      end(res, 200, this.briefs.map((b) => ({ ...b, result: b.result ? { topic: b.result.topic, claims: b.result.claims.length } : null })));
      return true;
    }
    if (req.method === "GET" && p.startsWith("/control/briefs/")) {
      const b = this.briefs.find((x) => x.id === p.split("/")[3] || x.intentId === p.split("/")[3]);
      end(res, b ? 200 : 404, b ?? { error: "unknown brief" });
      return true;
    }
    if (req.method === "GET" && p.startsWith("/media/")) {
      const file = this.media.serve(p.slice("/media/".length));
      if (!file) end(res, 404, { error: "unknown file" });
      else {
        res.writeHead(200, { "content-type": file.type, "content-length": file.body.length, "cache-control": "public, max-age=31536000, immutable" });
        res.end(file.body);
      }
      return true;
    }
    if (req.method === "GET" && p === "/control/studios") {
      end(res, 200, this.studiosView());
      return true;
    }
    if (req.method === "GET" && p.startsWith("/control/studios/")) {
      const j = this.studioJobs.find((x) => x.id === p.split("/")[3]);
      end(res, j ? 200 : 404, j ?? { error: "unknown studio job" });
      return true;
    }
    if (req.method === "GET" && p === "/control/market") {
      end(res, 200, { running: this.cfg.market, buyers: this.cfg.market ? this.cfg.simBuyers : 0, sellers: this.cfg.market ? this.cfg.simSellers : 0, seed: this.cfg.simSeed, rounds: this.market?.rounds ?? [] });
      return true;
    }
    if (req.method === "GET" && p === "/control/logs") {
      end(res, 200, this.logs.slice(-200));
      return true;
    }
    if (req.method === "POST" && (p === "/guest/renew" || p === "/guest/session")) {
      try {
        end(res, 200, p === "/guest/renew" ? await this.renewGuest(String((body as { agentId?: string } | null)?.agentId ?? "")) : await this.guestSession());
      } catch (err) {
        end(res, 429, { error: (err as Error).message });
      }
      return true;
    }
    if (req.method === "POST" && p.startsWith("/control/")) {
      if (req.headers["x-admin-token"] !== this.cfg.adminToken) {
        end(res, 401, { error: "admin token required" });
        return true;
      }
      const action = p.split("/")[2];
      const b = (body ?? {}) as { scenario?: string; goal?: string; budget?: number; perJobCap?: number; minReputation?: number; services?: string[]; deadlineMinutes?: number };
      try {
        if (action === "start") end(res, 200, await this.scenario(b.scenario ?? ""));
        else if (action === "commission") {
          const c = (body ?? {}) as { studio?: string; brief?: Record<string, unknown> };
          end(res, 200, await this.commission(String(c.studio ?? "") as StudioKind, c.brief ?? null, "admin"));
        }
        else if (action === "intent") {
          // demo convenience: the operator signs an intent for the orchestrator on the presenter's behalf
          const orch = this.agents.get("orchestrator");
          if (!orch) throw new Error("the research swarm is not running");
          const now = BigInt(Math.floor(Date.now() / 1000));
          const view = await this.operator.authorise(this.client, {
            buyer: orch.agentId,
            goal: String(b.goal ?? "Produce a researched, fact-checked brief on NEAR Protocol").slice(0, 300),
            budget: USD(Math.min(100, Math.max(0.01, Number(b.budget ?? 20)))),
            perJobCap: USD(Math.max(0, Number(b.perJobCap ?? 0.05))),
            minSellerReputation: Math.round(Math.min(1000, Math.max(0, Number(b.minReputation ?? 700)))),
            allowedServices: Array.isArray(b.services) ? b.services.map(String) : [],
            allowedSellers: [],
            notBefore: now - 60n,
            deadline: now + BigInt(Math.round(Math.max(1, Number(b.deadlineMinutes ?? 60)) * 60)),
            nonce: BigInt(Date.now()),
          });
          end(res, 200, { ok: true, message: `intent ${view.id.slice(0, 10)} signed by ${this.operator.accountId}`, intent: view });
        } else if (action === "pause") {
          this.state.paused = true;
          end(res, 200, { ok: true, message: "swarm paused (settlement continues)" });
        } else if (action === "resume") {
          this.state.paused = false;
          end(res, 200, { ok: true, message: "swarm resumed" });
        } else if (action === "reset") {
          this.reset();
          end(res, 200, { ok: true, message: "scenario state reset; balances and collateral topped up" });
        } else if (action === "background") {
          this.state.background = !this.state.background;
          end(res, 200, { ok: true, message: `background traffic ${this.state.background ? "on" : "off"}` });
        } else end(res, 404, { error: `unknown action ${action}` });
      } catch (err) {
        end(res, 400, { ok: false, message: (err as Error).message });
      }
      return true;
    }
    return false;
  }

  private async status() {
    const agents = await Promise.all(
      [...this.agents.entries()].map(async ([slug, a]) => {
        const [near, spendable] = await Promise.all([a.near.rpc.account(a.accountId).catch(() => null), a.intentsBalance().catch(() => 0n)]);
        return {
          slug,
          agentId: a.agentId.toString(),
          account: a.accountId,
          near: near ? (Number(near.amount / (ONE_NEAR / 1000n)) / 1000).toFixed(3) : "0",
          intentsBalance: formatUnits(spendable),
          lastActive: this.activity.get(slug) ?? null,
          offline: this.state.offline.has(slug),
        };
      }),
    );
    return {
      reachable: true,
      ready: this.ready,
      network: this.cfg.network,
      research: this.cfg.research,
      market: this.cfg.market,
      paused: this.state.paused,
      background: this.state.background,
      scenario: this.state.scenario && this.state.scenario.until > Date.now() ? this.state.scenario : null,
      rogueBadRate: this.state.rogueBadRate,
      briefsRunning: this.briefs.filter((b) => b.status === "running").length,
      studiosRunning: this.studioJobs.filter((j) => j.status === "forming" || j.status === "working").length,
      studios: this.cfg.studios,
      roundsRunning: this.market?.busy ?? 0,
      agents,
    };
  }
}

export { RoundVoidError };

function demoIntent(buyer: bigint, goal: string, budgetUsd: number) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return { buyer, goal, budget: USD(budgetUsd), perJobCap: USD(0.05), minSellerReputation: 700, allowedServices: [], allowedSellers: [], notBefore: now - 60n, deadline: now + 3_600n, nonce: BigInt(Date.now()) };
}

function guestIntent(buyer: bigint) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    buyer,
    goal: "Guest session: hire Quorum agents from an MCP client",
    budget: USD(1),
    perJobCap: USD(0.06),
    minSellerReputation: 600,
    allowedServices: [],
    allowedSellers: [],
    notBefore: now - 60n,
    deadline: now + 7n * 86_400n,
    nonce: BigInt(Date.now()),
  };
}

export function topicFromGoal(goal: string): string {
  const m = goal.match(/\b(?:on|about|of)\s+["“]?([^"”,.]+?)["”]?(?:\s+in\s+(?:english|hindi)|[,.]|$)/i);
  return (m?.[1] ?? goal).trim().slice(0, 100);
}

async function waitFor<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i % 5 === 0) console.log(`waiting for ${what}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}
