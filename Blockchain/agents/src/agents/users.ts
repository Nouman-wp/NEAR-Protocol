import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, bytesToHex, readSession, sessionSecret, type Session } from "@yuki/core";
import { YukiAgent } from "@yuki/sdk";
import type { Fleet } from "../fleet.ts";
import { agentKey } from "../config.ts";
import { STUDIOS, briefFor, type StudioKind } from "./studios.ts";

/**
 * Agents that signed-in users launch from the dashboard. Each is its own sub-account of
 * the root, hosted by this swarm (it holds the key, so the agent can sign IOUs and its own
 * settlements), but registered on chain with the user's wallet account as its operator.
 * Only that account can authorise the agent's spending: the user signs the intent in their
 * wallet, and the clearing service checks the key on chain. The swarm funds each agent
 * with test USDC so it can trade straight away.
 */

export interface UserAgentRecord {
  slug: string;
  owner: string;
  name: string;
  createdAt: number;
}

const PER_OWNER = 3;
const PER_HOUR = 12;
const USD = (n: number) => BigInt(Math.round(n * 1e6));

export class UserAgents {
  private records: UserAgentRecord[] = [];
  private readonly file: string;
  private recent: number[] = [];
  private readonly secret: Uint8Array;
  private creating = new Set<string>();

  constructor(private readonly fleet: Fleet) {
    this.file = join(fleet.cfg.dataDir, "user-agents.json");
    this.secret = sessionSecret(fleet.cfg.seed);
    if (existsSync(this.file)) {
      try {
        this.records = JSON.parse(readFileSync(this.file, "utf8")) as UserAgentRecord[];
      } catch {
        this.records = [];
      }
    }
  }

  session(authorization: string | undefined): Session | null {
    return readSession(this.secret, authorization);
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.records, null, 2));
  }

  private connect(rec: UserAgentRecord): Promise<YukiAgent> {
    const f = this.fleet;
    const key = agentKey(f.cfg.seed, rec.slug);
    return YukiAgent.connect({ accountId: `${rec.slug}.${f.clearing.deployment.root}`, secretKey: key.secretKey, clearingUrl: f.cfg.clearingUrl, rpcUrl: f.cfg.rpcUrl, config: f.clearing, agentId: 0n });
  }

  private profile(agent: YukiAgent, rec: UserAgentRecord): void {
    agent.setProfile({ slug: rec.slug, name: rec.name, role: "User agent", description: `An agent operated by ${rec.owner}, launched from the Yuki dashboard.`, baseUrl: `${this.fleet.cfg.publicUrl}/users/${rec.slug}` });
  }

  /** Bring back every user agent after a restart, so it keeps signing its settlements. */
  async startAll(): Promise<void> {
    // a fresh local sandbox has none of the accounts an earlier run created
    const live: UserAgentRecord[] = [];
    for (const rec of this.records) {
      const exists = await this.fleet.operator.near.rpc.account(`${rec.slug}.${this.fleet.clearing.deployment.root}`).catch(() => undefined);
      if (exists !== null) live.push(rec);
    }
    if (live.length !== this.records.length) {
      this.records = live;
      this.save();
    }
    for (const rec of this.records) {
      try {
        const agent = await this.connect(rec);
        this.profile(agent, rec);
        agent.agentId = await agent.lookupAgentId();
        // the card URL on chain follows the public domain if it moves
        await agent.ensureUri(`${this.fleet.cfg.publicUrl}/users/${rec.slug}/registration.json`).catch((err) => this.fleet.log("users", `${rec.slug}: card URL not updated (${(err as Error).message})`));
        this.fleet.agents.set(rec.slug, agent);
      } catch (err) {
        this.fleet.log("users", `could not reconnect ${rec.slug}: ${(err as Error).message}`);
      }
    }
    if (this.records.length) this.fleet.log("users", `${this.records.length} user agent(s) back online`);
  }

  list(owner: string) {
    return this.records
      .filter((r) => r.owner === owner)
      .map((r) => {
        const a = this.fleet.agents.get(r.slug);
        return { ...r, agentId: a?.agentId.toString() ?? null, account: a?.accountId ?? `${r.slug}.${this.fleet.clearing.deployment.root}`, ready: !!a && a.agentId !== 0n };
      });
  }

  /** The hosted agent behind a slug, if it is a user agent. */
  hosted(slug: string): YukiAgent | null {
    if (!this.records.some((r) => r.slug === slug)) return null;
    return this.fleet.agents.get(slug) ?? null;
  }

  async create(owner: string, rawName: string): Promise<{ slug: string; agentId: string; account: string }> {
    const name = rawName.replace(/[^\p{L}\p{N} '._-]/gu, "").trim().slice(0, 32) || "My agent";
    if (this.records.filter((r) => r.owner === owner).length >= PER_OWNER) throw new Error(`an account can run ${PER_OWNER} agents here`);
    this.recent = this.recent.filter((t) => t > Date.now() - 3_600_000);
    if (this.recent.length >= PER_HOUR) throw new Error("too many agents launched in the last hour; try again later");
    if (this.creating.has(owner)) throw new Error("already launching an agent for this account");
    this.creating.add(owner);
    this.recent.push(Date.now());
    try {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "agent";
      const slug = `${base}-${bytesToHex(randomBytes(2)).slice(2)}`;
      const rec: UserAgentRecord = { slug, owner, name, createdAt: Date.now() };
      const f = this.fleet;
      const agent = await this.connect(rec);
      this.profile(agent, rec);
      await f.operator.ensureSubAccount(slug, agent.publicKey, f.cfg.nearTarget);
      // the user's wallet account is the operator on chain: only it can authorise spending
      const agentId = await agent.register(`${f.cfg.publicUrl}/users/${slug}/registration.json`, owner);
      this.records.push(rec);
      this.save();
      f.agents.set(slug, agent);
      await f.fundUserAgent(agent, USD(2), USD(2));
      await agent.ensureIntentsKey();
      f.log("users", `${owner} launched agent #${agentId} ${agent.accountId}`);
      return { slug, agentId: agentId.toString(), account: agent.accountId };
    } finally {
      this.creating.delete(owner);
    }
  }

  /** The user's agent commissions a studio, paying under an intent the user signed. */
  async hire(owner: string, slug: string, kind: StudioKind, brief: Record<string, unknown> | null): Promise<{ ok: boolean; message: string }> {
    const rec = this.records.find((r) => r.slug === slug && r.owner === owner);
    if (!rec) throw new Error("that agent is not yours");
    const agent = this.fleet.agents.get(slug);
    if (!agent || agent.agentId === 0n) throw new Error("the agent is still starting");
    const studio = STUDIOS.find((s) => s.kind === kind);
    if (!studio) throw new Error(`unknown studio ${kind}`);
    const intents = await this.fleet.client.intents({ buyer: agent.agentId.toString() });
    const now = Date.now() / 1000;
    const intent = intents.find((i) => i.status === "active" && i.operator === owner && i.deadline > now && BigInt(i.budget) - BigInt(i.spent) >= studio.price && BigInt(i.perJobCap) >= studio.price);
    if (!intent) throw new Error(`authorise spending first: ${rec.name} needs an active intent you signed, with at least ${Number(studio.price) / 1e6} USDC left and a per-job cap that covers it`);
    const [lead] = await agent.findSellers(studio.service, { minReputation: 0 });
    if (!lead) throw new Error(`${studio.name} is not taking work right now`);
    const input = briefFor(kind, brief);
    this.fleet.log(slug, `commissions ${studio.name} for ${owner}: ${JSON.stringify(input).slice(0, 100)}`);
    void agent.hire(lead, studio.service, input, { intentId: intent.id }).then(
      (r) => this.fleet.log(slug, `${studio.name} delivered job ${r.jobId.slice(0, 10)}`),
      (err) => this.fleet.log(slug, `${studio.name} commission failed: ${(err as Error).message}`),
    );
    return { ok: true, message: `${rec.name} hired the ${studio.name}. Its lead tenders each role on chain now; the commission appears below in a few seconds.` };
  }

  /**
   * Local sandbox only: an account for a key the browser generated, so the dashboard can be
   * used without a wallet. Sign-in and intents then go through exactly the same checks.
   */
  async devAccount(publicKey: string): Promise<{ accountId: string }> {
    if (this.fleet.cfg.network !== "local") throw new Error("dev accounts exist on the local sandbox only; use a NEAR wallet");
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicKey)) throw new Error("not an ed25519 public key");
    const name = `dev-${bytesToHex(randomBytes(3)).slice(2)}`;
    const accountId = await this.fleet.operator.ensureSubAccount(name, publicKey, 1_000_000_000_000_000_000_000_000n);
    this.fleet.log("users", `dev account ${accountId} created for a browser key`);
    return { accountId };
  }

  /** Studio commissions placed by this owner's agents. */
  commissions(owner: string) {
    const ids = new Set(this.list(owner).map((a) => a.agentId).filter(Boolean));
    return this.fleet.studioJobs.filter((j) => j.client && ids.has(j.client.agentId)).map((j) => ({ ...j, deliverables: undefined, delivered: j.deliverables !== null }));
  }
}
