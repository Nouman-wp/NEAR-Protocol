import { randomUUID } from "node:crypto";
import { formatUsd } from "@yuki/core";
import { RefusedError, type ChainRound, type HireResult, type YukiAgent } from "@yuki/sdk";
import type { Fleet, FleetMember } from "../fleet.ts";
import { seeded, strategy, type StrategyName } from "../strategies.ts";
import { makeBrandSheet, makeLogo, makePalette, makeTypeScale, vibeOf, type DesignBrief, type Palette, type TypeScale } from "../work/design.ts";
import { audit, sloppy, templateOf, writeContract, writeTests, type Audit, type ContractBrief, type ContractCode, type TestSuite } from "../work/contracts.ts";
import { crossCheck, lintSpec, resourceOf, writeCode, writeSchema, writeSpec, type BackendBrief, type Resource } from "../work/backend.ts";
import { decodeJpeg, encodeJpeg, grade, GRADES, loadSource, reframe, retouch, stats, type Grade, type Stats } from "../work/image.ts";
import { captions, renderCut, storyboard, type Storyboard, type VideoBrief } from "../work/video.ts";
import type { MediaRef } from "../work/media.ts";
import { writeCopy, type BrandCopy } from "../work/copy.ts";

/**
 * Studios: hire an orchestrator, and it hires its team.
 *
 * Each studio is a lead agent that sells one finished product (a brand kit, a smart
 * contract, a REST API, a photo edit, a short video). When a client hires it, the lead puts
 * every role on its team out to a sealed-bid tender on chain at once. Freelancers with
 * overlapping skills bid with scripted strategies; the contract picks each winner. The
 * lead then hands the work down the line, checks every deliverable, disputes bad work
 * through the validator, and delivers the assembled result. Every hire is a signed IOU,
 * so the client's payment to the lead and the lead's payments to its team all net in the
 * same epoch.
 */

export type StudioKind = "design" | "contracts" | "backend" | "photo" | "video";

export interface RoleDef {
  service: string;
  name: string;
  /** the most the lead pays for this role in its tender (base units, 6 decimals) */
  reserve: bigint;
  description: string;
}

export const ROLES: Record<string, RoleDef> = {
  palette: { service: "palette", name: "Colour palette", reserve: 1_500n, description: "A five-colour palette from a name and a vibe, with WCAG contrast checks on the pairs the brand will use." },
  typeset: { service: "typeset", name: "Type scale", reserve: 1_200n, description: "A font pairing and a modular type scale, as CSS custom properties." },
  logo: { service: "logo", name: "Logo mark", reserve: 2_500n, description: "A geometric logo mark and wordmark as SVG, in the brand's palette." },
  copy: { service: "copy", name: "Brand copy", reserve: 1_500n, description: "A tagline, a short brand story, three voice traits and three headlines for a brand." },
  "contract-code": { service: "contract-code", name: "Contract code", reserve: 6_000n, description: "A NEAR smart contract in Rust (near-sdk 5) from an escrow, token or voting template." },
  "contract-tests": { service: "contract-tests", name: "Contract tests", reserve: 3_000n, description: "A unit-test module for a NEAR contract, with a coverage report of its require! guards." },
  "contract-audit": { service: "contract-audit", name: "Contract audit", reserve: 4_000n, description: "A static audit of a NEAR contract's source: access checks, deposits, callbacks, arithmetic, storage prefixes." },
  "api-spec": { service: "api-spec", name: "API spec", reserve: 2_500n, description: "An OpenAPI 3.1 spec for a resource's CRUD endpoints, linted." },
  "db-schema": { service: "db-schema", name: "Database schema", reserve: 1_800n, description: "Postgres DDL for a resource: types, constraints, checks and indexes." },
  "api-code": { service: "api-code", name: "API code", reserve: 4_000n, description: "Fastify route handlers with zod validation, generated from an OpenAPI spec." },
  retouch: { service: "retouch", name: "Retouch", reserve: 2_000n, description: "Fetches the photo and retouches it: auto levels, a contrast curve and sharpening." },
  grade: { service: "grade", name: "Colour grade", reserve: 1_500n, description: "Colour-grades a photo to a look: film, noir, teal-orange, vintage or vivid." },
  reframe: { service: "reframe", name: "Reframe", reserve: 1_500n, description: "Crops a photo for square, story and banner formats around its most detailed region." },
  storyboard: { service: "storyboard", name: "Storyboard", reserve: 2_000n, description: "A shot list from a Wikipedia topic: photos, camera moves and captions." },
  cut: { service: "cut", name: "Edit", reserve: 5_000n, description: "Renders a storyboard into an animated GIF: Ken Burns moves and crossfades over the photos." },
  captions: { service: "captions", name: "Captions", reserve: 1_200n, description: "WebVTT captions timed to a storyboard, checked against broadcast limits." },
};

export interface StudioDef {
  kind: StudioKind;
  slug: string;
  name: string;
  service: string;
  product: string;
  price: bigint;
  description: string;
  /** the roles the lead tenders, in the order the work flows */
  roles: string[];
  examples: Record<string, unknown>[];
}

export const STUDIOS: StudioDef[] = [
  {
    kind: "design",
    slug: "atelier",
    name: "Design Team",
    service: "design-studio",
    product: "Brand kit",
    price: 10_000n,
    description: "Turns a name and a vibe into a brand kit: palette with contrast checks, type scale, logo mark, brand copy and a one-page brand sheet.",
    roles: ["palette", "typeset", "logo", "copy"],
    examples: [
      { name: "Monsoon Coffee", vibe: "warm", tagline: "Brewed slow, served warm" },
      { name: "Glacier Labs", vibe: "cool", tagline: "Cold storage for hot data" },
      { name: "Terra Market", vibe: "earthy", tagline: "Grown close to home" },
      { name: "Pixel Arcade", vibe: "neon", tagline: "Insert coin" },
    ],
  },
  {
    kind: "contracts",
    slug: "forge",
    name: "Smart Contract Team",
    service: "contract-studio",
    product: "NEAR smart contract",
    price: 25_000n,
    description: "Writes a NEAR contract in Rust, has it tested and independently audited, and sends back sloppy work.",
    roles: ["contract-code", "contract-audit", "contract-tests"],
    examples: [
      { name: "Bazaar Escrow", template: "escrow", param: 100 },
      { name: "Guild Points", template: "token", param: 1_000_000 },
      { name: "Commons Council", template: "voting", param: 60 },
    ],
  },
  {
    kind: "backend",
    slug: "foundry",
    name: "Backend Team",
    service: "backend-studio",
    product: "REST API",
    price: 15_000n,
    description: "Designs a REST API for a resource: OpenAPI spec, Postgres schema and Fastify handlers, checked against each other.",
    roles: ["api-spec", "db-schema", "api-code"],
    examples: [{ resource: "booking" }, { resource: "order" }, { resource: "task", auth: false }],
  },
  {
    kind: "photo",
    slug: "darkroom",
    name: "Photo Team",
    service: "photo-studio",
    product: "Photo edit",
    price: 9_000n,
    description: "Takes the lead photo of any Wikipedia article (or a Wikimedia image), retouches it, grades it to a look and crops it for social formats.",
    roles: ["retouch", "grade", "reframe"],
    examples: [
      { topic: "Taj Mahal", look: "film" },
      { topic: "Mount Everest", look: "teal-orange" },
      { topic: "Gateway of India", look: "vintage" },
      { topic: "Hampi", look: "vivid" },
    ],
  },
  {
    kind: "video",
    slug: "cutroom",
    name: "Marketing Team",
    service: "video-studio",
    product: "Promo video",
    price: 14_000n,
    description: "Storyboards a topic from Wikipedia, cuts it into a short promo clip over real photos and captions it.",
    roles: ["storyboard", "cut", "captions"],
    examples: [
      { topic: "Monsoon of South Asia", shots: 4, look: "film" },
      { topic: "Kerala backwaters", shots: 4, look: "vivid" },
      { topic: "Rann of Kutch", shots: 4, look: "teal-orange" },
    ],
  },
];

export interface Freelancer {
  slug: string;
  name: string;
  role: string;
  description: string;
  /** service -> how it bids and what one job costs it */
  skills: Record<string, [StrategyName, bigint]>;
  /** some of its contract code skips an access check */
  sloppy?: number;
  /** does its writing with a NEAR AI Cloud model when one is configured */
  ai?: boolean;
}

export const FREELANCERS: Freelancer[] = [
  { slug: "hue", name: "Hue", role: "Colourist", description: "Colour for brands and photos; also storyboards and the odd logo.", skills: { palette: ["cost-plus", 900n], grade: ["adaptive", 900n], storyboard: ["noisy", 1_100n], logo: ["opportunist", 1_500n] } },
  { slug: "kern", name: "Kern", role: "Typographer", description: "Type scales and captions; writes API specs and template brand copy on the side.", skills: { typeset: ["cost-plus", 700n], captions: ["adaptive", 700n], "api-spec": ["noisy", 1_500n], palette: ["undercutter", 950n], copy: ["opportunist", 900n] } },
  { slug: "vector", name: "Vector", role: "Illustrator", description: "Logo marks, crops and quick edits.", skills: { logo: ["adaptive", 1_400n], reframe: ["cost-plus", 900n], cut: ["noisy", 3_000n], typeset: ["opportunist", 800n] } },
  { slug: "ferris", name: "Ferris", role: "Rust developer", description: "Careful NEAR contracts and their tests; TypeScript backends too.", skills: { "contract-code": ["cost-plus", 3_800n], "contract-tests": ["adaptive", 1_800n], "api-code": ["noisy", 2_500n] } },
  { slug: "ledger", name: "Ledger", role: "Developer (budget)", description: "Undercuts on contract work and backends. Fast, and sometimes forgets an access check.", skills: { "contract-code": ["undercutter", 2_600n], "api-spec": ["cost-plus", 1_400n], "db-schema": ["adaptive", 1_000n], "api-code": ["cost-plus", 2_400n] }, sloppy: 0.5 },
  { slug: "sigil", name: "Sigil", role: "Security auditor", description: "Audits NEAR contracts line by line; writes tests and schemas.", skills: { "contract-audit": ["cost-plus", 2_500n], "contract-tests": ["noisy", 1_900n], "db-schema": ["opportunist", 1_200n] } },
  { slug: "warden", name: "Warden", role: "Security auditor", description: "A second auditor that follows the going rate.", skills: { "contract-audit": ["adaptive", 2_300n], "api-spec": ["adaptive", 1_300n] } },
  { slug: "lumen", name: "Lumen", role: "Photo retoucher", description: "Retouching, grading and reframing; cuts video when it has to.", skills: { retouch: ["cost-plus", 1_200n], grade: ["undercutter", 950n], reframe: ["adaptive", 950n], cut: ["cost-plus", 3_100n] } },
  { slug: "quill", name: "Quill", role: "AI copywriter", description: "Writes brand copy with a NEAR AI Cloud model (private inference inside a TEE, each answer signed by the enclave). Falls back to a template writer when no model is configured.", skills: { copy: ["cost-plus", 800n] }, ai: true },
  { slug: "reel", name: "Reel", role: "Video editor", description: "Storyboards, cuts and captions; retouches frames.", skills: { storyboard: ["adaptive", 1_200n], cut: ["undercutter", 2_900n], captions: ["cost-plus", 750n], retouch: ["noisy", 1_300n] } },
];

export interface TeamSeat {
  role: string;
  name: string;
  roundId: number | null;
  bids: number;
  winner: { agentId: string; name: string } | null;
  price: string | null;
  via: "tender" | "posted" | null;
  jobId: string | null;
}

export interface StudioJob {
  id: string;
  studio: StudioKind;
  lead: string;
  client: { agentId: string; name: string } | null;
  brief: Record<string, unknown>;
  label: string;
  status: "forming" | "working" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  price: string;
  spent: string;
  team: TeamSeat[];
  disputes: { role: string; seller: string; reason: string; upheld: boolean | null }[];
  steps: { at: number; text: string }[];
  deliverables: Record<string, unknown> | null;
  error: string | null;
}

export const studioMembers = (): FleetMember[] => [
  {
    slug: "founder",
    group: "studios",
    profile: { name: "Founder", role: "Client", description: "A startup founder agent with a budget. Commissions brand kits, contracts, APIs, photos and videos from the studios.", fleet: true },
    install: () => undefined,
    buys: [{ key: "main", goal: "[standing] Commission studio work", services: STUDIOS.map((s) => s.service), budget: 20_000_000n, perJobCap: 50_000n, minRep: 0 }],
  },
  ...STUDIOS.map((s): FleetMember => ({
    slug: s.slug,
    group: "studios",
    profile: { name: s.name, role: `Team lead · ${s.product.toLowerCase()}`, description: s.description, fleet: true },
    install: (fleet: Fleet, agent: YukiAgent) => installLead(fleet, agent, s),
    buys: [{ key: "main", goal: `[standing] Hire the ${s.name.toLowerCase()}`, services: [...s.roles, "verdict"], budget: 20_000_000n, perJobCap: 10_000n, minRep: 500 }],
  })),
  ...FREELANCERS.map((f): FleetMember => ({
    slug: f.slug,
    group: "studios",
    profile: { name: f.name, role: f.role, description: f.description, fleet: true },
    install: (fleet: Fleet, agent: YukiAgent) => installFreelancer(fleet, agent, f),
    buys: [],
  })),
];

// ------------------------------------------------------------------ freelancers

type Work = (fleet: Fleet, input: Record<string, unknown>, f: Freelancer) => Promise<unknown>;

const media = (fleet: Fleet, url: unknown) => {
  const bytes = fleet.media.read(String(url ?? ""));
  if (!bytes) throw new Error("the image to work on is not in this swarm's media store");
  return decodeJpeg(bytes);
};

const WORK: Record<string, Work> = {
  palette: async (_f, input) => makePalette(input as unknown as DesignBrief),
  typeset: async (_f, input) => makeTypeScale(input as unknown as DesignBrief),
  logo: async (fleet, input) => {
    const brief = input as unknown as DesignBrief & { palette?: Palette };
    const logo = makeLogo(brief, brief.palette ?? makePalette(brief));
    return { motif: logo.motif, svg: logo.svg, file: fleet.media.put(logo.svg, "svg", { width: 240, height: 240 }) };
  },
  copy: async (_f, input, f) => writeCopy(input as unknown as DesignBrief, { useModel: !!f.ai }),
  "contract-code": async (_f, input, f) => {
    const code = writeContract(input as unknown as ContractBrief);
    return f.sloppy && Math.random() < f.sloppy ? sloppy(code) : code;
  },
  "contract-tests": async (_f, input) => writeTests(input.code as ContractCode),
  "contract-audit": async (_f, input) => audit(String(input.source ?? "")),
  "api-spec": async (_f, input) => {
    const resource = resourceOf(input as unknown as BackendBrief);
    const spec = writeSpec(resource);
    return { resource, spec, lint: lintSpec(spec) };
  },
  "db-schema": async (_f, input) => writeSchema(input.resource as Resource),
  "api-code": async (_f, input) => writeCode(input.resource as Resource, input.spec as Record<string, unknown>),
  retouch: async (fleet, input) => {
    const src = await loadSource({ topic: input.topic as string | undefined, imageUrl: input.imageUrl as string | undefined });
    const out = retouch(src.img);
    const size = { width: out.width, height: out.height };
    return {
      source: { url: src.url, title: src.title, license: src.license, synthetic: src.synthetic },
      original: fleet.media.put(encodeJpeg(src.img), "jpg", size),
      retouched: fleet.media.put(encodeJpeg(out), "jpg", size),
      before: stats(src.img),
      after: stats(out),
    };
  },
  grade: async (fleet, input) => {
    const look = (GRADES as readonly string[]).includes(String(input.look)) ? (input.look as Grade) : "film";
    const out = grade(media(fleet, input.image), look);
    return { look, graded: fleet.media.put(encodeJpeg(out), "jpg", { width: out.width, height: out.height }), stats: stats(out) };
  },
  reframe: async (fleet, input) => {
    const img = media(fleet, input.image);
    const crops = Object.fromEntries(
      (["square", "story", "banner"] as const).map((fmt) => {
        const r = reframe(img, fmt);
        return [fmt, { ...fleet.media.put(encodeJpeg(r), "jpg", { width: r.width, height: r.height }), window: r.window }];
      }),
    );
    return { crops };
  },
  storyboard: async (_f, input) => storyboard(input as unknown as VideoBrief),
  cut: async (fleet, input) => {
    const cut = await renderCut(input.storyboard as Storyboard);
    return { gif: fleet.media.put(cut.gif, "gif", { width: cut.width, height: cut.height }), frames: cut.frames, seconds: cut.seconds, sources: cut.sources };
  },
  captions: async (fleet, input) => {
    const c = captions(input.storyboard as Storyboard);
    return { vtt: fleet.media.put(c.vtt, "vtt"), cues: c.cues, checks: c.checks };
  },
};

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function installFreelancer(fleet: Fleet, agent: YukiAgent, f: Freelancer): void {
  for (const [service, [name, cost]] of Object.entries(f.skills)) {
    const role = ROLES[service]!;
    agent.sell<Record<string, unknown>, unknown>({
      id: service,
      name: role.name,
      description: role.description,
      // posted price, for work bought outside a tender: a little under the role's reserve
      price: (role.reserve * 9n) / 10n > cost ? (role.reserve * 9n) / 10n : cost,
      unit: "job",
      tags: ["studio", service],
      handler: async (input) => {
        const out = await WORK[service]!(fleet, input ?? {}, f);
        fleet.touch(f.slug);
        return out;
      },
    });
    agent.bidOn(service, strategy(name, { cost, history: () => fleet.priceHistory(service), rand: seeded(hashSeed(`${f.slug}:${service}`)) }));
  }
}

// ------------------------------------------------------------------ leads

export function installLead(fleet: Fleet, agent: YukiAgent, studio: StudioDef): void {
  agent.sell<Record<string, unknown>, unknown>({
    id: studio.service,
    name: studio.product,
    description: `${studio.description} Hires its team in sealed-bid tenders: ${studio.roles.map((r) => ROLES[r]!.name.toLowerCase()).join(", ")}.`,
    price: studio.price,
    unit: "commission",
    tags: ["studio", studio.kind, "orchestrator"],
    examples: studio.examples.slice(0, 2).map((e) => JSON.stringify(e)),
    handler: async (input, ctx) => {
      const rec = await runStudio(fleet, studio, input ?? {}, { parentJobId: ctx.jobId, buyer: ctx.buyer });
      if (rec.status !== "done" || !rec.deliverables) throw new Error(rec.error ?? "the studio could not finish the job");
      return { studio: studio.kind, job: rec.id, team: rec.team.map((t) => ({ role: t.role, agent: t.winner?.name ?? null, price: t.price, round: t.roundId })), deliverables: rec.deliverables };
    },
  });
}

const labelOf = (studio: StudioDef, b: Record<string, unknown>) => String(b.name ?? b.resource ?? b.topic ?? studio.product).slice(0, 60);

export async function runStudio(fleet: Fleet, studio: StudioDef, brief: Record<string, unknown>, ctx: { parentJobId?: string; buyer?: string }): Promise<StudioJob> {
  const rec: StudioJob = {
    id: `studio_${randomUUID().slice(0, 8)}`,
    studio: studio.kind,
    lead: studio.slug,
    client: null,
    brief,
    label: labelOf(studio, brief),
    status: "forming",
    startedAt: Date.now(),
    finishedAt: null,
    price: studio.price.toString(),
    spent: "0",
    team: studio.roles.map((r) => ({ role: r, name: ROLES[r]!.name, roundId: null, bids: 0, winner: null, price: null, via: null, jobId: null })),
    disputes: [],
    steps: [],
    deliverables: null,
    error: null,
  };
  fleet.studioJobs.unshift(rec);
  if (fleet.studioJobs.length > 40) fleet.studioJobs.pop();
  const step = (text: string) => {
    rec.steps.push({ at: Date.now(), text });
    fleet.log(studio.slug, `[${rec.id}] ${text}`);
    fleet.markStudioJobs();
  };
  if (ctx.buyer) {
    const c = await fleet.agentSummary(ctx.buyer).catch(() => null);
    rec.client = { agentId: ctx.buyer, name: c?.name ?? `Agent #${ctx.buyer}` };
  }
  const lead = fleet.agents.get(studio.slug)!;
  const intentId = fleet.standing.get(`${studio.slug}:main`);
  let spent = 0n;
  const seat = (role: string) => rec.team.find((t) => t.role === role)!;
  const charge = (role: string, r: HireResult<unknown>, via: TeamSeat["via"]) => {
    spent += r.price;
    rec.spent = spent.toString();
    const s = seat(role);
    s.price = r.price.toString();
    s.via = via;
    s.jobId = r.jobId;
    s.winner = { agentId: r.seller.agentId, name: r.seller.name };
  };

  try {
    if (!intentId) throw new Error(`${studio.name} has no standing intent to pay its team`);
    step(`commission from ${rec.client?.name ?? "a client"}: ${studio.product.toLowerCase()} for "${rec.label}"`);

    // 1. the team: one sealed-bid tender per role, all open at once
    step(`putting ${studio.roles.length} roles out to sealed-bid tender`);
    const rounds = await Promise.all(
      studio.roles.map(async (role): Promise<ChainRound | null> => {
        const def = ROLES[role]!;
        const s = seat(role);
        try {
          const spec = { studio: studio.kind, role, brief, commission: rec.id };
          const { roundId } = await lead.openRound({ kind: "Tender", service: role, spec, title: `${studio.name}: ${def.name.toLowerCase()} for ${rec.label}`, quantity: 1, reservePrice: def.reserve, commitMs: fleet.cfg.commitMs, revealMs: fleet.cfg.revealMs });
          s.roundId = roundId;
          const round = await lead.awaitRound(roundId);
          s.bids = round.bids.length;
          if (round.status !== "Closed" || round.winner === null) {
            step(`${def.name}: round #${roundId} void (${round.void_reason || "no bids"}); will hire at a posted price`);
            return null;
          }
          fleet.notePrice(role, BigInt(round.clearing_price));
          const w = await fleet.agentSummary(String(round.winner)).catch(() => null);
          s.winner = { agentId: String(round.winner), name: w?.name ?? `Agent #${round.winner}` };
          s.price = round.clearing_price;
          step(`${def.name}: ${round.bids.length} sealed bid(s) in round #${roundId}, ${s.winner.name} wins at ${formatUsd(BigInt(round.clearing_price))}`);
          return round;
        } catch (err) {
          step(`${def.name}: tender failed (${(err as Error).message}); will hire at a posted price`);
          return null;
        }
      }),
    );
    rec.status = "working";
    step(`team: ${rec.team.map((t) => `${t.winner?.name ?? "?"} (${t.name.toLowerCase()})`).join(", ")}`);

    const roundOf = (role: string) => rounds[studio.roles.indexOf(role)] ?? null;
    const used = new Set<string>();
    /** Buy one role: from its round's winner the first time, at posted prices after a dispute. */
    const hireRole = async <T>(role: string, input: unknown, exclude: string[] = []): Promise<HireResult<T>> => {
      const round = roundOf(role);
      if (round && !used.has(role) && !exclude.includes(String(round.winner))) {
        used.add(role);
        const r = await lead.hireRoundWinner<T>(round, input, { intentId, parentJobId: ctx.parentJobId ?? null });
        charge(role, r, "tender");
        return r;
      }
      const r = await fleet.hire<T>(studio.slug, role, input, { intentId, parentJobId: ctx.parentJobId ?? null, exclude, minReputation: 500 });
      charge(role, r, "posted");
      return r;
    };

    // 2. the work, in order
    rec.deliverables = await PLANS[studio.kind]({ fleet, studio, brief, hireRole, step, rec, intentId, refund: (p) => ((spent -= p), (rec.spent = spent.toString())) });
    rec.status = "done";
    step(`delivered: ${rec.team.length} roles, team cost ${formatUsd(spent)} of the ${formatUsd(studio.price)} commission`);
  } catch (err) {
    rec.status = "failed";
    rec.error = err instanceof RefusedError ? `refused: ${err.message}` : (err as Error).message;
    step(`failed: ${rec.error}`);
  } finally {
    rec.finishedAt = Date.now();
    fleet.markStudioJobs();
  }
  return rec;
}

interface PlanCtx {
  fleet: Fleet;
  studio: StudioDef;
  brief: Record<string, unknown>;
  hireRole: <T>(role: string, input: unknown, exclude?: string[]) => Promise<HireResult<T>>;
  step: (s: string) => void;
  rec: StudioJob;
  intentId: string;
  refund: (price: bigint) => void;
}

const PLANS: Record<StudioKind, (c: PlanCtx) => Promise<Record<string, unknown>>> = {
  async design({ fleet, brief, hireRole, step }) {
    const b: DesignBrief = { name: String(brief.name ?? "Untitled").slice(0, 40), vibe: brief.vibe as DesignBrief["vibe"], tagline: brief.tagline ? String(brief.tagline).slice(0, 80) : undefined };
    const vibe = vibeOf(b);
    // copy is a bonus: the kit still ships if no copywriter can be hired
    const [pal, type, copy] = await Promise.all([
      hireRole<Palette>("palette", { ...b, vibe }),
      hireRole<TypeScale>("typeset", { ...b, vibe }),
      hireRole<BrandCopy>("copy", { ...b, vibe }).catch((err) => (step(`brand copy: no copywriter could be hired (${(err as Error).message})`), null)),
    ]);
    const failing = pal.result.pairs.filter((p) => !p.aa);
    step(failing.length ? `palette: ${failing.length} pair(s) below WCAG AA` : `palette: all ${pal.result.pairs.length} contrast pairs pass WCAG AA`);
    if (copy) {
      const e = copy.result.engine;
      step(`brand copy by ${copy.seller.name}: ${e.kind === "near-ai" ? `written by ${e.model} on NEAR AI Cloud in ${(e.ms / 1000).toFixed(1)}s${e.signature ? ", signed by the enclave" : ""}` : e.reason}`);
    }
    const logo = await hireRole<{ motif: string; svg: string; file: MediaRef }>("logo", { ...b, vibe, palette: pal.result });
    const sheet = makeBrandSheet({ ...b, tagline: b.tagline ?? copy?.result.tagline }, pal.result, type.result, logo.result.svg);
    step(`brand sheet assembled (${logo.result.motif} mark, ${type.result.display} / ${type.result.text})`);
    return { name: b.name, vibe, palette: pal.result, type: type.result, logo: logo.result.file, motif: logo.result.motif, copy: copy?.result ?? null, sheet: fleet.media.put(sheet, "svg", { width: 960, height: 540 }) };
  },

  async contracts({ fleet, brief, hireRole, step, rec, intentId, studio, refund }) {
    const b: ContractBrief = { name: String(brief.name ?? "Escrow").slice(0, 40), template: templateOf({ name: String(brief.name ?? ""), template: brief.template as ContractBrief["template"] }), param: typeof brief.param === "number" ? brief.param : undefined };
    let code = await hireRole<ContractCode>("contract-code", b);
    const lib = (c: ContractCode) => c.files.find((f) => f.path === "src/lib.rs")?.content ?? "";
    let aud = await hireRole<Audit>("contract-audit", { source: lib(code.result), template: b.template }, [code.seller.agentId]);
    step(`audit by ${aud.seller.name}: score ${aud.result.score}, ${aud.result.findings.filter((f) => f.severity === "high").length} high finding(s)`);
    for (let attempt = 0; !aud.result.pass && attempt < 2; attempt++) {
      const high = aud.result.findings.filter((f) => f.severity === "high");
      const reason = `audit failed: ${high.map((f) => `${f.rule} in ${f.method ?? "?"} (line ${f.line})`).join("; ")}`;
      step(`${code.seller.name}'s contract fails the audit; disputing (${reason})`);
      const d = { role: "contract-code", seller: code.seller.name, reason, upheld: null as boolean | null };
      rec.disputes.push(d);
      const verdict = (await fleet.dispute(studio.slug, code.jobId, reason, intentId).catch((err) => (step(`dispute failed: ${(err as Error).message}`), null))) as { upheld?: boolean; reasoning?: string } | null;
      d.upheld = verdict?.upheld ?? null;
      if (d.upheld) refund(code.price);
      step(`Arbiter ${d.upheld ? "upholds" : "rejects"} the dispute${verdict?.reasoning ? `: ${verdict.reasoning}` : ""}`);
      const bad = code.seller.agentId;
      code = await hireRole<ContractCode>("contract-code", b, [bad]);
      aud = await hireRole<Audit>("contract-audit", { source: lib(code.result), template: b.template }, [code.seller.agentId]);
      step(`rewritten by ${code.seller.name}; re-audit by ${aud.seller.name}: score ${aud.result.score}`);
    }
    if (!aud.result.pass) throw new Error("no contract passed the audit");
    const tests = await hireRole<TestSuite>("contract-tests", { code: code.result });
    const covered = tests.result.guards.filter((g) => g.covered).length;
    step(`tests by ${tests.seller.name}: ${tests.result.cases.length} cases, ${covered}/${tests.result.guards.length} guards covered`);
    return {
      template: code.result.template,
      crate: code.result.crate,
      methods: code.result.methods,
      files: [...code.result.files, { path: tests.result.path, content: tests.result.content }],
      audit: aud.result,
      tests: { cases: tests.result.cases, guards: tests.result.guards },
    };
  },

  async backend({ brief, hireRole, step }) {
    const b: BackendBrief = { resource: String(brief.resource ?? "task").slice(0, 40), fields: Array.isArray(brief.fields) ? (brief.fields as BackendBrief["fields"]) : undefined, auth: brief.auth === false ? false : true };
    const spec = await hireRole<{ resource: Resource; spec: Record<string, unknown>; lint: string[] }>("api-spec", b);
    step(`spec by ${spec.seller.name}: ${Object.keys(spec.result.spec.paths as object).length} paths, ${spec.result.lint.length} lint problem(s)`);
    const [schema, code] = await Promise.all([
      hireRole<{ sql: string; columns: string[]; indexes: string[] }>("db-schema", { resource: spec.result.resource }),
      hireRole<{ path: string; content: string; handlers: string[] }>("api-code", { resource: spec.result.resource, spec: spec.result.spec }),
    ]);
    const problems = crossCheck(spec.result.resource, spec.result.spec, schema.result, code.result);
    step(problems.length ? `cross-check found ${problems.length} problem(s): ${problems.slice(0, 3).join("; ")}` : `cross-check: ${code.result.handlers.length} operations handled, ${schema.result.columns.length} columns, spec, schema and code agree`);
    return { resource: spec.result.resource, spec: spec.result.spec, schema: schema.result, code: code.result, checks: problems };
  },

  async photo({ brief, hireRole, step }) {
    const look = (GRADES as readonly string[]).includes(String(brief.look)) ? (brief.look as Grade) : "film";
    const input = { topic: brief.topic ? String(brief.topic).slice(0, 100) : undefined, imageUrl: brief.imageUrl ? String(brief.imageUrl) : undefined };
    const rt = await hireRole<{ source: { url: string | null; title: string | null; license: string; synthetic: boolean }; original: MediaRef; retouched: MediaRef; before: Stats; after: Stats }>("retouch", input);
    step(`retouched ${rt.result.source.synthetic ? "a generated test scene (no photo found)" : `"${rt.result.source.title}"`}: contrast ${rt.result.before.contrast} -> ${rt.result.after.contrast}`);
    const gr = await hireRole<{ look: Grade; graded: MediaRef; stats: Stats }>("grade", { image: rt.result.retouched.url, look });
    const fr = await hireRole<{ crops: Record<string, MediaRef & { window: unknown }> }>("reframe", { image: gr.result.graded.url });
    step(`graded "${look}" and reframed: ${Object.entries(fr.result.crops).map(([k, v]) => `${k} ${v.width}x${v.height}`).join(", ")}`);
    return { look, source: rt.result.source, original: rt.result.original, retouched: rt.result.retouched, graded: gr.result.graded, crops: fr.result.crops, stats: { before: rt.result.before, after: rt.result.after, graded: gr.result.stats } };
  },

  async video({ brief, hireRole, step }) {
    const b: VideoBrief = { topic: String(brief.topic ?? "Monsoon").slice(0, 100), title: brief.title ? String(brief.title) : undefined, shots: typeof brief.shots === "number" ? brief.shots : 4, look: brief.look as Grade | undefined };
    const sb = await hireRole<Storyboard>("storyboard", b);
    step(`storyboard by ${sb.seller.name}: ${sb.result.shots.length} shots, ${sb.result.shots.filter((s) => s.image).length} with photos, ${sb.result.totalSeconds}s`);
    const [cut, cap] = await Promise.all([
      hireRole<{ gif: MediaRef; frames: number; seconds: number; sources: unknown[] }>("cut", { storyboard: sb.result }),
      hireRole<{ vtt: MediaRef; cues: unknown[]; checks: { name: string; ok: boolean }[] }>("captions", { storyboard: sb.result }),
    ]);
    const failed = cap.result.checks.filter((c) => !c.ok);
    step(`cut by ${cut.seller.name}: ${cut.result.frames} frames, ${cut.result.seconds}s; captions by ${cap.seller.name}: ${failed.length ? `${failed.length} check(s) failed` : "all checks pass"}`);
    return { storyboard: sb.result, cut: cut.result, captions: cap.result };
  },
};

/** A brief for a studio: the given one, or one of its examples. */
export function briefFor(kind: StudioKind, given?: Record<string, unknown> | null): Record<string, unknown> {
  const s = STUDIOS.find((x) => x.kind === kind)!;
  if (given && Object.keys(given).length) return given;
  return s.examples[Math.floor(Math.random() * s.examples.length)]!;
}
