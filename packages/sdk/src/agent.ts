import { randomUUID } from "node:crypto";
import {
  NearAccount,
  NearRpc,
  QUORUM_PRICING_EXTENSION,
  TGAS,
  bidCommitment,
  bytesToHex,
  disputeDigest,
  hashJson,
  intentsTokenId,
  iouDigest,
  jobHash,
  quoteDigest,
  randomBytes,
  routeUrl,
  signMessage,
  signSettlement,
  usd,
  verifyMessage,
  type A2AAgentCard,
  type AccountId,
  type AgentRegistration,
  type AgentSummary,
  type Delivery,
  type Hex,
  type IOU,
  type JobSpec,
  type MessageKind,
  type MessageOf,
  type Pricing,
  type PublicKey,
  type QuorumDomain,
  type Quote,
  type RoundKind,
  type RoundView,
  type ServiceListing,
  type Signature,
  type TxResult,
} from "@quorum/core";
import { ClearingClient, type ClearingConfig } from "./client.ts";

export interface JobContext {
  jobId: string;
  buyer: string;
  service: string;
  spec: JobSpec;
  agent: QuorumAgent;
}

export interface ServiceDef<I = unknown, O = unknown> {
  id: string;
  name: string;
  description: string;
  /** Price per call: base units as bigint, or a decimal string like "0.0004". */
  price: bigint | string;
  unit: string;
  tags?: string[];
  examples?: string[];
  handler: (input: I, ctx: JobContext) => Promise<O>;
  /** Optional dynamic pricing; the quote is binding once signed. */
  priceFor?: (input: I) => bigint;
}

export interface AgentProfile {
  slug: string;
  name: string;
  description: string;
  role: string;
  /** Public base URL where this agent's A2A endpoints are mounted. */
  baseUrl: string;
  image?: string;
  validator?: boolean;
  fleet?: boolean;
  organization?: string;
}

export interface PreparedJob {
  jobId: string;
  iouDigest: Hex;
  epoch: number;
  price: bigint;
  seller: AgentSummary;
  jobSpec: JobSpec;
  service: string;
}

export interface HireResult<O = unknown> extends PreparedJob {
  result: O;
  delivery: Record<keyof Delivery, string>;
}

export interface BuyOptions {
  intentId: string;
  parentJobId?: string | null;
  maxPrice?: bigint;
  /** the sealed-bid round that set this job's price */
  round?: number;
}

/** `get_round` on the coordinator contract. */
export interface ChainRound {
  id: number;
  kind: RoundKind;
  pricing: Pricing;
  status: "Open" | "Closed" | "Void";
  opener: number;
  service: string;
  spec_hash: Hex;
  reserve_price: string;
  min_reputation: number;
  join_deadline: number;
  commit_deadline: number;
  reveal_deadline: number;
  demand: { buyer: number; quantity: number; max_price: string }[];
  bids: { seller: number; commitment: Hex; price: string | null }[];
  winner: number | null;
  clearing_price: string;
  total_quantity: number;
  allocations: { buyer: number; quantity: number; cost: string }[];
  void_reason: string;
}

export interface OpenRoundOptions {
  kind: RoundKind;
  service: string;
  /** The full job specification. Only its hash goes on chain; the text is published through the clearing service. */
  spec: unknown;
  title?: string;
  quantity?: number;
  /** the most the buyer pays per unit, in base units */
  reservePrice: bigint;
  minReputation?: number;
  pricing?: Pricing;
  joinMs?: number;
  commitMs?: number;
  revealMs?: number;
}

/** Decides a seller's sealed bid for a round, or null to sit it out. */
export type BidStrategy = (round: RoundView) => bigint | null;

export class RefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`refused by clearing: ${reason}`);
    this.reason = reason;
  }
}

export class RoundVoidError extends Error {
  readonly roundId: number;
  constructor(roundId: number, reason: string) {
    super(`round #${roundId} is void: ${reason}`);
    this.roundId = roundId;
  }
}

type Str<T> = { [K in keyof T]: string };

const strs = <T extends object>(o: T): Str<T> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : String(v)])) as Str<T>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Quorum agent: one NEAR account, one signing key, one on-chain identity, any number of
 * services sold, and the ability to hire other agents. Money moves by signed IOUs cleared
 * through the coordinator contract, prices are found in sealed-bid rounds the agent joins
 * from its own account, and net debts settle as NEAR Intents transfers it signs itself.
 */
export class QuorumAgent {
  readonly near: NearAccount;
  readonly client: ClearingClient;
  readonly cfg: ClearingConfig;
  readonly domain: QuorumDomain;
  agentId: bigint;
  profile: AgentProfile | null = null;
  private services = new Map<string, ServiceDef<never, unknown>>();
  private lastNonce = 0n;
  private epochCache: { epoch: number; intakeEndsAt: number } | null = null;
  private settling = false;
  private intentsKeyReady = false;
  private bidders = new Map<string, BidStrategy>();
  /** sealed bids this agent has committed and must reveal */
  private sealed = new Map<number, { price: bigint; salt: Hex; revealed: boolean }>();
  private bidding = new Set<number>();
  /** public URL prefixes this agent can reach locally (see routeUrl) */
  routes: [string, string][] = [];

  private constructor(opts: { near: NearAccount; client: ClearingClient; cfg: ClearingConfig; agentId: bigint }) {
    this.near = opts.near;
    this.client = opts.client;
    this.cfg = opts.cfg;
    this.agentId = opts.agentId;
    this.domain = opts.cfg.domain;
  }

  /** Connect to a clearing service. The agent id is looked up from the coordinator contract. */
  static async connect(opts: { accountId: AccountId; secretKey: string; clearingUrl: string; rpcUrl?: string; agentId?: bigint; config?: ClearingConfig }): Promise<QuorumAgent> {
    const client = new ClearingClient(opts.clearingUrl);
    const cfg = opts.config ?? (await client.config());
    const near = new NearAccount(new NearRpc(opts.rpcUrl ?? cfg.network.rpc), opts.accountId, opts.secretKey);
    const agent = new QuorumAgent({ near, client, cfg, agentId: opts.agentId ?? 0n });
    if (!opts.agentId) agent.agentId = await agent.lookupAgentId();
    return agent;
  }

  get accountId(): AccountId {
    return this.near.accountId;
  }

  get publicKey(): PublicKey {
    return this.near.publicKey;
  }

  private get contract(): AccountId {
    return this.cfg.deployment.contract;
  }

  /** 0 if this account is not registered yet. */
  async lookupAgentId(): Promise<bigint> {
    return BigInt((await this.near.view<number | null>(this.contract, "agent_id_of", { account_id: this.accountId })) ?? 0);
  }

  /** Register this account as an agent. `uri` is where its registration file is served. */
  async register(uri: string, operator?: AccountId): Promise<bigint> {
    const r = await this.near.call<number>(this.contract, "register", { uri, public_key: this.publicKey, operator: operator ?? null });
    this.agentId = BigInt(r.value);
    return this.agentId;
  }

  setProfile(p: AgentProfile): this {
    this.profile = p;
    return this;
  }

  // =================================================================== money

  /** Token balance in the agent's own account, outside the verifier. */
  async tokenBalance(): Promise<bigint> {
    return BigInt(await this.near.view<string>(this.cfg.deployment.token, "ft_balance_of", { account_id: this.accountId }));
  }

  /** Spendable balance inside the NEAR Intents verifier: what settlement transfers draw on. */
  async intentsBalance(): Promise<bigint> {
    return BigInt(await this.near.view<string>(this.cfg.deployment.intents, "mt_balance_of", { account_id: this.accountId, token_id: intentsTokenId(this.cfg.deployment.token) }));
  }

  /** Move tokens from the agent's account into the verifier. */
  depositToIntents(amount: bigint): Promise<TxResult> {
    return this.near.call(this.cfg.deployment.token, "ft_transfer_call", { receiver_id: this.cfg.deployment.intents, amount: amount.toString(), msg: "" }, { deposit: 1n, gas: 100n * TGAS });
  }

  /** Let the verifier accept this agent's signing key. Needed once before the first settlement. */
  async ensureIntentsKey(): Promise<void> {
    const has = await this.near.view<boolean>(this.cfg.deployment.intents, "has_public_key", { account_id: this.accountId, public_key: this.publicKey });
    if (!has) await this.near.call(this.cfg.deployment.intents, "add_public_key", { public_key: this.publicKey }, { deposit: 1n });
  }

  /** Post collateral with the coordinator. It backs every net debt of this agent. */
  depositCollateral(amount: bigint): Promise<TxResult> {
    return this.near.call(this.cfg.deployment.token, "ft_transfer_call", { receiver_id: this.contract, amount: amount.toString(), msg: this.agentId.toString() }, { deposit: 1n, gas: 100n * TGAS });
  }

  async collateral(): Promise<{ total: bigint; locked: bigint; available: bigint }> {
    const c = await this.near.view<{ total: string; locked: string; pending_withdrawal: string }>(this.contract, "get_collateral", { agent_id: Number(this.agentId) });
    const total = BigInt(c.total);
    const locked = BigInt(c.locked);
    return { total, locked, available: total - locked - BigInt(c.pending_withdrawal) };
  }

  // =================================================================== seller

  sell<I, O>(def: ServiceDef<I, O>): this {
    this.services.set(def.id, def as unknown as ServiceDef<never, unknown>);
    return this;
  }

  listings(): ServiceListing[] {
    return [...this.services.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: priceUnits(s.price).toString(),
      unit: s.unit,
      tags: s.tags ?? [],
    }));
  }

  listedPrice(service: string): bigint | undefined {
    const s = this.services.get(service);
    return s ? priceUnits(s.price) : undefined;
  }

  /** A2A agent card with Quorum's pricing extension. */
  card(): A2AAgentCard & { quorum: Record<string, unknown> } {
    const p = this.requireProfile();
    const prices: Record<string, { price: string; unit: string }> = {};
    for (const s of this.listings()) prices[s.id] = { price: s.price, unit: s.unit };
    return {
      protocolVersion: "0.3.0",
      name: p.name,
      description: p.description,
      url: `${p.baseUrl}/a2a`,
      preferredTransport: "JSONRPC",
      version: "1.0.0",
      provider: { organization: p.organization ?? "Quorum", url: p.baseUrl },
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [
          {
            uri: QUORUM_PRICING_EXTENSION,
            description: "Per-call prices in stablecoin base units; payment by signed IOU cleared on Quorum and settled through NEAR Intents.",
            required: true,
            params: {
              agentId: this.agentId.toString(),
              account: this.accountId,
              network: this.cfg.network.key,
              contract: this.contract,
              token: this.cfg.deployment.token,
              clearingApi: this.client.baseUrl,
              prices,
            },
          },
        ],
      },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json"],
      skills: [...this.services.values()].map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags ?? [], examples: s.examples })),
      quorum: { slug: p.slug, role: p.role, validator: !!p.validator, fleet: !!p.fleet },
    };
  }

  /** The registration file the agent's on-chain `uri` points at. */
  registration(): AgentRegistration & { quorum: Record<string, unknown> } {
    const p = this.requireProfile();
    return {
      type: "quorum-agent-registration-v1",
      name: p.name,
      description: p.description,
      image: p.image ?? "",
      endpoints: [
        { name: "A2A", endpoint: `${p.baseUrl}/.well-known/agent-card.json`, version: "0.3.0" },
        { name: "nearAccount", endpoint: `near:${this.cfg.network.key}:${this.accountId}` },
      ],
      registrations: this.agentId ? [{ agentId: Number(this.agentId), account: this.accountId, contract: this.contract }] : [],
      supportedTrust: ["reputation", "crypto-economic", "validation"],
      quorum: { slug: p.slug, role: p.role, validator: !!p.validator, fleet: !!p.fleet },
    };
  }

  /**
   * Step 1 of a sale: a signed, binding quote for this exact job. For a job priced by a
   * sealed-bid round the price is not the seller's to choose: it is read from the chain.
   */
  async quote(req: { buyer: string; service: string; input: unknown; round?: number }) {
    const svc = this.services.get(req.service);
    if (!svc) throw new Error(`unknown service ${req.service}`);
    let price = svc.priceFor ? svc.priceFor(req.input as never) : priceUnits(svc.price);
    if (req.round !== undefined) {
      const round = await this.chainRound(req.round);
      if (round.status !== "Closed") throw new Error(`round #${req.round} is not closed`);
      if (BigInt(round.winner ?? 0) !== this.agentId) throw new Error(`round #${req.round} was won by agent #${round.winner}`);
      if (round.service !== req.service) throw new Error(`round #${req.round} was for ${round.service}`);
      const allocation = round.allocations.find((a) => String(a.buyer) === String(req.buyer));
      if (!allocation) throw new Error(`agent #${req.buyer} has no allocation in round #${req.round}`);
      price = BigInt(allocation.cost);
    }
    const jobSpec: JobSpec = {
      buyer: String(req.buyer),
      seller: this.agentId.toString(),
      service: req.service,
      input: req.input,
      requestedAt: Date.now(),
      salt: randomUUID(),
      ...(req.round !== undefined ? { round: String(req.round) } : {}),
    };
    const quote: Quote = {
      seller: this.agentId,
      buyer: BigInt(req.buyer),
      service: req.service,
      price,
      token: this.cfg.deployment.token,
      jobHash: jobHash(jobSpec),
      expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
      quoteNonce: BigInt(Date.now()),
    };
    return { quote: strs(quote), quoteSignature: this.sign("Quote", quote), jobSpec };
  }

  /** Step 2 of a sale: the clearing service accepted the buyer's IOU; do the work and sign delivery. */
  async execute(req: { jobId: string; jobSpec: JobSpec; iouDigest: Hex }) {
    const jd = await this.client.job(req.jobId);
    if (jd.job.seller !== this.agentId.toString()) throw new Error("job is for another seller");
    if (jd.job.jobHash !== jobHash(req.jobSpec)) throw new Error("job spec does not match the cleared job");
    if (!jd.iou || jd.iou.digest !== req.iouDigest) throw new Error("IOU not cleared for this job");
    if (jd.job.status !== "accepted" && jd.job.status !== "delivered") throw new Error(`job is ${jd.job.status}`);
    const svc = this.services.get(req.jobSpec.service);
    if (!svc) throw new Error(`unknown service ${req.jobSpec.service}`);
    const result = await svc.handler(req.jobSpec.input as never, { jobId: req.jobId, buyer: req.jobSpec.buyer, service: svc.id, spec: req.jobSpec, agent: this });
    const delivery: Delivery = {
      seller: this.agentId,
      jobHash: jd.job.jobHash,
      iouDigest: req.iouDigest,
      resultHash: hashJson(result),
      deliveredAt: BigInt(Date.now()),
    };
    const signature = this.sign("Delivery", delivery);
    await this.client.deliver({ jobId: req.jobId, delivery: strs(delivery), signature, result });
    return { result, delivery: strs(delivery), deliverySignature: signature };
  }

  /** A2A JSON-RPC entry point (`message/send` with a Quorum data part). */
  async handleA2A(body: { jsonrpc?: string; id?: unknown; method?: string; params?: { message?: { parts?: { kind: string; data?: unknown }[] } } }) {
    const id = body.id ?? null;
    try {
      if (body.method !== "message/send") return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
      const part = body.params?.message?.parts?.find((p) => p.kind === "data");
      const k = (part?.data as { quorum?: { action: string } & Record<string, unknown> } | undefined)?.quorum;
      if (!k) return { jsonrpc: "2.0", id, error: { code: -32602, message: "expected a data part with a `quorum` object" } };
      let out: unknown;
      if (k.action === "quote") out = await this.quote(k as never);
      else if (k.action === "execute") out = await this.execute(k as never);
      else if (k.action === "card") out = this.card();
      else return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown action ${k.action}` } };
      return {
        jsonrpc: "2.0",
        id,
        result: { kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "data", data: { quorum: out } }] },
      };
    } catch (err) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } };
    }
  }

  // =================================================================== sealed-bid rounds

  chainRound(roundId: number): Promise<ChainRound> {
    return this.near.view<ChainRound | null>(this.contract, "get_round", { round_id: roundId }).then((r) => {
      if (!r) throw new Error(`unknown round #${roundId}`);
      return r;
    });
  }

  /** Open a tender or a group buy from this agent's own account. */
  async openRound(o: OpenRoundOptions): Promise<{ roundId: number; tx: string }> {
    const r = await this.near.call<number>(
      this.contract,
      "open_round",
      {
        kind: o.kind,
        pricing: o.pricing ?? "SecondPrice",
        service: o.service,
        spec_hash: hashJson(o.spec),
        quantity: o.quantity ?? 1,
        reserve_price: o.reservePrice.toString(),
        min_reputation: o.minReputation ?? 0,
        join_ms: o.kind === "GroupBuy" ? (o.joinMs ?? 5_000) : 0,
        commit_ms: o.commitMs ?? 5_000,
        reveal_ms: o.revealMs ?? 5_000,
      },
      { gas: 50n * TGAS },
    );
    const roundId = r.value;
    // tell the clearing service now rather than at its next poll, and publish what the round is for
    void (async () => {
      await this.client.refreshRound(roundId).catch(() => undefined);
      await this.client.describeRound(roundId, o.spec, o.title).catch(() => undefined);
      await this.client.noteRoundTx(roundId, "open", r.hash, this.accountId).catch(() => undefined);
    })();
    return { roundId, tx: r.hash };
  }

  /** Add this agent's demand to a group buy. */
  joinRound(roundId: number, quantity: number, maxPrice: bigint): Promise<TxResult> {
    return this.near.call(this.contract, "join_round", { round_id: roundId, quantity, max_price: maxPrice.toString() }, { gas: 30n * TGAS });
  }

  /** Commit to a hidden unit price. The salt stays with the agent until the reveal. */
  async commitBid(roundId: number, price: bigint): Promise<TxResult> {
    const salt = bytesToHex(randomBytes(32));
    const r = await this.near.call(this.contract, "commit_bid", { round_id: roundId, commitment: bidCommitment(roundId, this.agentId, price, salt) }, { gas: 30n * TGAS });
    this.sealed.set(roundId, { price, salt, revealed: false });
    return r;
  }

  async revealBid(roundId: number): Promise<TxResult> {
    const bid = this.sealed.get(roundId);
    if (!bid) throw new Error(`no sealed bid for round #${roundId}`);
    const r = await this.near.call(this.contract, "reveal_bid", { round_id: roundId, price: bid.price.toString(), salt: bid.salt }, { gas: 30n * TGAS });
    bid.revealed = true;
    return r;
  }

  /** Anyone may close a round once its windows have passed. The contract decides the result. */
  async closeRound(roundId: number): Promise<ChainRound> {
    const r = await this.near.call<ChainRound>(this.contract, "close_round", { round_id: roundId }, { gas: 60n * TGAS });
    void (async () => {
      await this.client.refreshRound(roundId).catch(() => undefined);
      await this.client.noteRoundTx(roundId, "close", r.hash, this.accountId).catch(() => undefined);
    })();
    return r.value;
  }

  /** Wait for a round to finish, closing it as soon as the contract allows. */
  async awaitRound(roundId: number, timeoutMs = 10 * 60_000): Promise<ChainRound> {
    const started = Date.now();
    for (;;) {
      const round = await this.chainRound(roundId);
      if (round.status !== "Open") return round;
      const now = Date.now();
      const allRevealed = round.bids.length > 0 && round.bids.every((b) => b.price !== null);
      if ((now >= round.commit_deadline + 500 && allRevealed) || now >= round.reveal_deadline + 500) {
        try {
          return await this.closeRound(roundId);
        } catch (err) {
          // the chain's clock is a moment behind ours, or someone else closed it first
          if (!/still running|round is closed/.test((err as Error).message)) throw err;
        }
      }
      if (now - started > timeoutMs) throw new Error(`round #${roundId} did not close in time`);
      const next = now < round.commit_deadline ? round.commit_deadline + 600 : now + 700;
      await sleep(Math.max(400, Math.min(next - now, 2_000)));
    }
  }

  /** Bid in every round for `service` with `strategy`. Call `considerRound` with open rounds to act. */
  bidOn(service: string, strategy: BidStrategy): this {
    this.bidders.set(service, strategy);
    return this;
  }

  /**
   * Act on an open round if this agent bids on its service: commit while the commit
   * window is open, reveal once it has closed. Safe to call again and again.
   */
  async considerRound(round: RoundView): Promise<"committed" | "revealed" | null> {
    const strategy = this.bidders.get(round.service);
    const me = this.agentId.toString();
    if (!strategy || round.status !== "Open" || this.agentId === 0n || this.bidding.has(round.id)) return null;
    if (round.demand.some((d) => d.buyer === me)) return null;
    const now = Date.now();
    const mine = this.sealed.get(round.id);
    this.bidding.add(round.id);
    try {
      if (!mine && now >= round.joinDeadline + 300 && now < round.commitDeadline - 1_200 && !round.bids.some((b) => b.seller === me)) {
        const price = strategy(round);
        if (price === null || price <= 0n) return null;
        await this.commitBid(round.id, price);
        return "committed";
      }
      if (mine && !mine.revealed && now >= round.commitDeadline + 500 && now < round.revealDeadline - 800) {
        await this.revealBid(round.id);
        return "revealed";
      }
      return null;
    } catch (err) {
      // a window that closed between the check and the transaction is not an error worth keeping
      if (/window|already|closed|joining/.test((err as Error).message)) return null;
      throw err;
    } finally {
      this.bidding.delete(round.id);
    }
  }

  // =================================================================== buyer

  /** Discover sellers of a capability, cheapest first, then best reputation. */
  async findSellers(service: string, opts: { maxPrice?: bigint; minReputation?: number; exclude?: string[] } = {}): Promise<AgentSummary[]> {
    const list = await this.client.agents({ capability: service, minReputation: opts.minReputation });
    return list
      .filter((a) => a.status === "active" && a.agentId !== this.agentId.toString() && !(opts.exclude ?? []).includes(a.agentId))
      .filter((a) => {
        const s = a.services.find((x) => x.id === service);
        return s && (opts.maxPrice === undefined || BigInt(s.price) <= opts.maxPrice);
      })
      .sort((a, b) => {
        const pa = BigInt(a.services.find((x) => x.id === service)!.price);
        const pb = BigInt(b.services.find((x) => x.id === service)!.price);
        if (pa !== pb) return pa < pb ? -1 : 1;
        return b.reputation - a.reputation;
      });
  }

  /** Quote + IOU: the job is cleared and the seller is guaranteed payment. */
  async buy(seller: AgentSummary, service: string, input: unknown, opts: BuyOptions): Promise<PreparedJob> {
    const q = (await this.callSeller(seller, { action: "quote", buyer: this.agentId.toString(), service, input, ...(opts.round !== undefined ? { round: opts.round } : {}) })) as Awaited<
      ReturnType<QuorumAgent["quote"]>
    >;
    const quote: Quote = {
      seller: BigInt(q.quote.seller),
      buyer: BigInt(q.quote.buyer),
      service: q.quote.service,
      price: BigInt(q.quote.price),
      token: q.quote.token,
      jobHash: q.quote.jobHash as Hex,
      expiry: BigInt(q.quote.expiry),
      quoteNonce: BigInt(q.quote.quoteNonce),
    };
    if (!verifyMessage(this.domain, "Quote", quote, q.quoteSignature, seller.publicKey)) throw new Error("quote not signed by the seller");
    if (quote.buyer !== this.agentId || jobHash(q.jobSpec) !== quote.jobHash) throw new Error("quote does not match the request");
    if ((q.jobSpec.round ?? null) !== (opts.round !== undefined ? String(opts.round) : null)) throw new Error("quote names a different round than the request");
    if (opts.maxPrice !== undefined && quote.price > opts.maxPrice) throw new Error(`quoted ${quote.price} above max ${opts.maxPrice}`);

    // At an epoch boundary the IOU can be refused for naming the epoch that just closed: wait
    // for the next one to open and sign again, a few times at most.
    for (let attempt = 0; attempt < 4; attempt++) {
      const epoch = await this.currentEpoch(attempt > 0);
      const iou: IOU = {
        buyer: this.agentId,
        seller: quote.seller,
        amount: quote.price,
        token: quote.token,
        jobHash: quote.jobHash,
        quoteHash: quoteDigest(this.domain, quote),
        epoch: BigInt(epoch),
        nonce: this.nextNonce(),
      };
      const r = await this.client.submitIou({
        iou: strs(iou),
        signature: this.sign("IOU", iou),
        quote: q.quote,
        quoteSignature: q.quoteSignature,
        jobSpec: q.jobSpec,
        intentId: opts.intentId,
        parentJobId: opts.parentJobId ?? null,
      });
      if (r.ok) {
        return { jobId: r.jobId, iouDigest: iouDigest(this.domain, iou), epoch: r.epoch, price: quote.price, seller, jobSpec: q.jobSpec, service };
      }
      if (r.currentEpoch !== undefined && /epoch|intake/.test(r.reason) && attempt < 3) {
        this.epochCache = null;
        await sleep(400 + attempt * 500);
        continue;
      }
      throw new RefusedError(r.reason);
    }
    throw new RefusedError("the epoch kept rolling over while signing");
  }

  /** Ask the seller to execute a cleared job and verify its signed delivery. */
  async run<O = unknown>(job: PreparedJob): Promise<HireResult<O>> {
    const out = (await this.callSeller(job.seller, { action: "execute", jobId: job.jobId, jobSpec: job.jobSpec, iouDigest: job.iouDigest })) as {
      result: O;
      delivery: Record<keyof Delivery, string>;
      deliverySignature: Signature;
    };
    const d: Delivery = {
      seller: BigInt(out.delivery.seller),
      jobHash: out.delivery.jobHash as Hex,
      iouDigest: out.delivery.iouDigest as Hex,
      resultHash: out.delivery.resultHash as Hex,
      deliveredAt: BigInt(out.delivery.deliveredAt),
    };
    if (!verifyMessage(this.domain, "Delivery", d, out.deliverySignature, job.seller.publicKey)) throw new Error("delivery not signed by the seller");
    if (hashJson(out.result) !== d.resultHash) throw new Error("result does not match the signed delivery");
    return { ...job, result: out.result, delivery: out.delivery };
  }

  async hire<O = unknown>(seller: AgentSummary, service: string, input: unknown, opts: BuyOptions): Promise<HireResult<O>> {
    const job = await this.buy(seller, service, input, opts);
    return this.run<O>(job);
  }

  /**
   * Put one job out to tender: open a sealed-bid round, wait for the contract to pick the
   * winner, then buy the job from that winner at the clearing price.
   */
  async tender<O = unknown>(
    service: string,
    input: unknown,
    opts: Omit<BuyOptions, "round" | "maxPrice"> & { reservePrice: bigint; quantity?: number; minReputation?: number; pricing?: Pricing; commitMs?: number; revealMs?: number; title?: string },
  ): Promise<HireResult<O> & { round: ChainRound }> {
    const spec = { service, input, buyer: this.agentId.toString(), title: opts.title ?? `${service} tender`, salt: randomUUID() };
    const { roundId } = await this.openRound({ kind: "Tender", service, spec, title: spec.title, quantity: opts.quantity, reservePrice: opts.reservePrice, minReputation: opts.minReputation, pricing: opts.pricing, commitMs: opts.commitMs, revealMs: opts.revealMs });
    const round = await this.awaitRound(roundId);
    if (round.status !== "Closed" || round.winner === null) throw new RoundVoidError(roundId, round.void_reason || "no winner");
    const job = await this.hireRoundWinner<O>(round, input, opts);
    return { ...job, round };
  }

  /** Buy this agent's allocation of a closed round from the round's winner. */
  async hireRoundWinner<O = unknown>(round: ChainRound, input: unknown, opts: Omit<BuyOptions, "round" | "maxPrice">): Promise<HireResult<O>> {
    if (round.status !== "Closed" || round.winner === null) throw new RoundVoidError(round.id, round.void_reason || "no winner");
    const mine = round.allocations.find((a) => BigInt(a.buyer) === this.agentId);
    if (!mine) throw new Error(`no allocation for this agent in round #${round.id}`);
    // the clearing service enforces the round's result, so it must have seen the close
    await this.client.refreshRound(round.id).catch(() => undefined);
    const { agent: winner } = await this.client.agent(String(round.winner));
    return this.hire<O>(winner, round.service, input, { ...opts, round: round.id, maxPrice: BigInt(mine.cost) });
  }

  /**
   * Dispute a delivered job. If an arbiter is given, its verdict is bought like any other
   * job (validators earn a fee) and the ruling comes back as that job's result.
   */
  async dispute(jobId: string, reason: string, opts: { intentId: string; arbiter?: AgentSummary }) {
    const jd = await this.client.job(jobId);
    if (!jd.iou) throw new Error("job has no IOU");
    let arbiterJob: PreparedJob | null = null;
    if (opts.arbiter) arbiterJob = await this.buy(opts.arbiter, "verdict", { jobId, reason }, { intentId: opts.intentId, parentJobId: jobId });
    const dispute = { buyer: this.agentId, jobHash: jd.job.jobHash, iouDigest: jd.iou.digest, reason, filedAt: BigInt(Date.now()) };
    const view = await this.client.fileDispute({ jobId, dispute: strs(dispute), signature: this.sign("Dispute", dispute), arbiterJobId: arbiterJob?.jobId ?? null });
    let verdict: unknown = null;
    if (arbiterJob) verdict = (await this.run(arbiterJob)).result;
    return { dispute: view, verdict, disputeHash: disputeDigest(this.domain, dispute) };
  }

  // =================================================================== validator

  /** Sign and submit a verdict; optionally also answer the request on chain from this agent's account. */
  async rule(disputeId: string, disputeHash: Hex, upheld: boolean, reasoning: string, opts: { onchain?: boolean } = {}) {
    const verdict = { disputeHash, validator: this.agentId, upheld, reasoning: reasoning.slice(0, 900), decidedAt: BigInt(Date.now()) };
    const view = await this.client.verdict(disputeId, { verdict: strs(verdict), signature: this.sign("Verdict", verdict) });
    if (opts.onchain) void this.respondOnChain(disputeHash, upheld, `${this.client.baseUrl}/v1/disputes/${disputeId}`);
    return view;
  }

  private async respondOnChain(requestHash: Hex, upheld: boolean, uri: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const v = await this.near.view<{ response: number | null } | null>(this.contract, "get_validation", { request_hash: requestHash });
        if (v) {
          if (v.response === null) await this.near.call(this.contract, "validation_response", { request_hash: requestHash, response: upheld ? 0 : 100, uri });
          return;
        }
      } catch {
        // request not on chain yet, or the stake is short: try again shortly
      }
      await sleep(3_000);
    }
  }

  // =================================================================== debtor

  /**
   * Sign the NEAR Intents transfers for every outstanding net debt and hand them to the
   * clearing service, which forwards each epoch's batch through the coordinator contract.
   * Safe to call repeatedly: one debt has one nonce, and the verifier refuses a second use.
   */
  async settleDebts(): Promise<{ settled: string[]; failed: { id: string; error: string }[] }> {
    if (this.settling || this.agentId === 0n) return { settled: [], failed: [] };
    this.settling = true;
    const settled: string[] = [];
    const failed: { id: string; error: string }[] = [];
    try {
      const orders = await this.client.settlements({ agentId: this.agentId.toString(), status: "awaiting_payment" });
      if (orders.length && !this.intentsKeyReady) {
        // the verifier only accepts keys the account itself registered with it
        await this.ensureIntentsKey();
        this.intentsKeyReady = true;
      }
      for (const o of orders) {
        try {
          if (o.order.account !== this.accountId) throw new Error(`order is for ${o.order.account}`);
          await this.client.submitIntent(o.id, signSettlement(o.order, this.near.keyPair.secretKey, this.publicKey));
          settled.push(o.id);
        } catch (err) {
          failed.push({ id: o.id, error: (err as Error).message });
        }
      }
    } finally {
      this.settling = false;
    }
    return { settled, failed };
  }

  // =================================================================== plumbing

  sign<K extends MessageKind>(kind: K, message: MessageOf[K]): Signature {
    return signMessage(this.domain, kind, message, this.near.keyPair.secretKey);
  }

  private async currentEpoch(force = false): Promise<number> {
    const now = Date.now();
    if (!force && this.epochCache && now < this.epochCache.intakeEndsAt - 250) return this.epochCache.epoch;
    const r = await this.client.nonce(this.agentId.toString());
    this.epochCache = { epoch: r.epoch, intakeEndsAt: r.intakeEndsAt };
    const serverNonce = BigInt(r.nonce) - 1n;
    if (serverNonce > this.lastNonce) this.lastNonce = serverNonce;
    return r.epoch;
  }

  private nextNonce(): bigint {
    const t = BigInt(Date.now()) * 1000n;
    this.lastNonce = t > this.lastNonce ? t : this.lastNonce + 1n;
    return this.lastNonce;
  }

  private async callSeller(seller: AgentSummary, quorum: Record<string, unknown>): Promise<unknown> {
    const url = routeUrl(seller.endpoint, this.routes);
    if (!url) throw new Error(`agent #${seller.agentId} has no endpoint`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "message/send",
        params: { message: { role: "user", messageId: randomUUID(), parts: [{ kind: "data", data: { quorum } }] } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as { result?: { parts?: { kind: string; data?: { quorum?: unknown } }[] }; error?: { message: string } };
    if (body.error) throw new Error(`${seller.name}: ${body.error.message}`);
    const part = body.result?.parts?.find((p) => p.kind === "data");
    return part?.data?.quorum;
  }

  private requireProfile(): AgentProfile {
    if (!this.profile) throw new Error("call setProfile() before publishing a card");
    return this.profile;
  }
}

function priceUnits(p: bigint | string): bigint {
  return typeof p === "bigint" ? p : p.includes(".") ? usd(p) : BigInt(p);
}
