import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { fleet, useLive } from "../lib/api.ts";
import { ago, plural, serviceName, standalone, teamName, titleCase, usd, usdExact } from "../lib/format.ts";
import { AgentChip, Avatar, Details, Empty, Go, Money, PageHead, Reveal, Status, Tag, hue } from "../components/ui.tsx";

interface Bidder {
  slug: string;
  name: string;
  strategy: string;
}
interface StudioInfo {
  kind: string;
  slug: string;
  name: string;
  service: string;
  product: string;
  price: string;
  description: string;
  examples: Record<string, unknown>[];
  agentId: string | null;
  roles: { service: string; name: string; reserve: string; description: string; bidders: Bidder[] }[];
}
interface Seat {
  role: string;
  name: string;
  roundId: number | null;
  bids: number;
  winner: { agentId: string; name: string } | null;
  price: string | null;
  via: "tender" | "posted" | null;
  jobId: string | null;
}
interface StudioJob {
  id: string;
  studio: string;
  lead: string;
  client: { agentId: string; name: string } | null;
  brief: Record<string, unknown>;
  label: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  price: string;
  spent: string;
  team: Seat[];
  disputes: { role: string; seller: string; reason: string; upheld: boolean | null }[];
  steps: { at: number; text: string }[];
  deliverables?: Record<string, unknown> | null;
  error: string | null;
}
interface AiStatus {
  provider: string;
  enabled: boolean;
  keySet?: boolean;
  model: string;
  lastError?: string | null;
}
interface BrandCopy {
  tagline: string;
  story: string;
  voice: string[];
  headlines: string[];
  engine: { kind: "near-ai"; model: string; chatId: string | null; ms: number; signature: { signature: string; signingAddress: string | null } | null } | { kind: "template"; reason: string };
}
interface StudiosView {
  running: boolean;
  ai?: AiStatus;
  studios: StudioInfo[];
  freelancers: { slug: string; name: string; role: string; description: string; ai?: boolean; agentId: string | null; skills: { service: string; strategy: string }[] }[];
  jobs: StudioJob[];
}
interface Media {
  url: string;
  sha256: string;
  bytes: number;
  type: string;
  width?: number;
  height?: number;
}

function useFleet<T>(path: string, refreshMs: number): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fleet<T>(path)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, refreshMs]);
  return { data, error };
}

const busy = (s: string) => s === "forming" || s === "working";

/** What to type for each team, and the style it is sent with. */
const BRIEF: Record<string, { field: string; label: string; placeholder: string; extra: Record<string, unknown> }> = {
  design: { field: "name", label: "Brand name", placeholder: "e.g. Chai Point", extra: { vibe: "warm" } },
  contracts: { field: "name", label: "Contract name", placeholder: "e.g. Bazaar Escrow", extra: { template: "escrow" } },
  backend: { field: "resource", label: "What the API manages", placeholder: "e.g. booking", extra: {} },
  photo: { field: "topic", label: "Photo of", placeholder: "e.g. Hampi", extra: { look: "film" } },
  video: { field: "topic", label: "Video about", placeholder: "e.g. Kerala backwaters", extra: { shots: 4, look: "film" } },
};

/** Team log lines, said plainly: sentence case, real plurals, rounded money, no setup jargon. */
export function plainLog(text: string): string {
  let t = text
    .replace(/(\d+)\s+([\w-]+(?: [\w-]+)?)\(s\)/g, (_, n: string, w: string) => `${n} ${n === "1" ? w : `${w}s`}`)
    .replace(/\b(\w+)\(s\)/g, "$1s")
    .replace(/\s*\(no [A-Z0-9_]+\)/g, "")
    .replace(/NEAR AI is not configured on this deployment/gi, "AI model offline")
    .replace(/so the template writer wrote it/gi, "so the built-in template wrote it")
    .replace(/sealed-bid tender/g, "auction")
    .replace(/sealed bid/g, "secret bid")
    .replace(/\btender #/g, "auction #")
    .replace(/\bround #/g, "auction #")
    .replace(/pass WCAG AA/g, "are easy to read")
    .replace(/signed by the enclave/g, "signed by the AI service")
    .replace(/ -> /g, " → ")
    .replace(/\bcommission\b/g, "order")
    .replace(/\$(\d+\.\d+)/g, (_, v: string) => usd(Math.round(Number(v) * 1e6)));
  t = t.replace(/^commission from/i, "Order from");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function OrderForm({ studios, kind, setKind }: { studios: StudioInfo[]; kind: string; setKind: (k: string) => void }) {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem("quorum-admin") ?? "quorum-admin";
    } catch {
      return "quorum-admin";
    }
  });
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const all = kind === "all";
  const team = studios.find((s) => s.kind === kind);
  const brief = BRIEF[kind];
  const post = async (path: string, body: unknown) => {
    setSending(true);
    try {
      localStorage.setItem("quorum-admin", token);
    } catch {
      /* private window: the key just isn't remembered */
    }
    try {
      const r = await fleet<{ ok?: boolean; message?: string }>(path, { method: "POST", body: JSON.stringify(body), headers: { "x-admin-token": token } });
      setMsg({ ok: r.ok !== false, text: r.ok !== false ? "Order placed. It appears under Recent orders in a few seconds." : (r.message ?? "That didn't go through.") });
      setText("");
    } catch (e) {
      const m = (e as Error).message;
      setMsg({ ok: false, text: /token|unauthor|forbidden|401|403/i.test(m) ? "The demo key was not accepted. Open “Demo key” below and check it." : `That didn't go through: ${m}` });
    } finally {
      setSending(false);
    }
  };
  const order = () =>
    all ? post("/control/start", { scenario: "studio-rush" }) : post("/control/commission", { studio: kind, brief: text.trim() && brief ? { [brief.field]: text.trim(), ...brief.extra } : null });
  const total = studios.reduce((n, s) => n + BigInt(s.price), 0n);
  return (
    <div className="card stack stack-md" id="order">
      <h2 className="h3">Place an order</h2>
      <p className="muted" style={{ margin: 0 }}>
        A demo buyer pays from its own NEAR account, inside a spending limit its owner signed.
      </p>
      <div className="stack stack-sm">
        <span className="label">Order from</span>
        <div className="seg" role="radiogroup" aria-label="Team" style={{ flexWrap: "wrap" }}>
          {studios.map((s) => (
            <button key={s.kind} role="radio" aria-checked={kind === s.kind} className={kind === s.kind ? "on" : ""} onClick={() => setKind(s.kind)}>
              {s.name}
            </button>
          ))}
          <button role="radio" aria-checked={all} className={all ? "on" : ""} onClick={() => setKind("all")}>
            All five
          </button>
        </div>
      </div>
      {!all && brief && (
        <label className="stack stack-sm" style={{ maxWidth: 420 }}>
          <span className="label">{brief.label} (optional)</span>
          <input id="order-input" value={text} maxLength={60} placeholder={brief.placeholder} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button className="btn" disabled={sending} onClick={() => void order()}>
          {sending ? "Ordering…" : all ? `Order from all five teams · ${usd(total)}` : `Order a ${productName(team?.product)} · ${usd(team?.price)}`} <Go />
        </button>
      </div>
      <Details summary="Demo key">
        <label className="stack stack-sm" style={{ maxWidth: 320 }}>
          <span className="muted" style={{ fontSize: 14 }}>
            Orders need a key. It is filled in for you; on a local run it is <code>quorum-admin</code>.
          </span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Demo key" />
        </label>
      </Details>
      {msg && (
        <p role="status" className="note" style={{ margin: 0, borderColor: msg.ok ? "var(--sage)" : "var(--bad)" }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** "Brand kit" → "brand kit", but "REST API" and "NEAR smart contract" keep their capitals. */
const productName = (p: string | undefined) => (p ?? "job").replace(/^\w+/, (w) => (w === w.toUpperCase() ? w : w.toLowerCase()));

/** The one picture that sums up each kind of order, if it has one. */
type Cover = { url: string; contain: boolean };
function cover(kind: string, d: Record<string, unknown> | null | undefined): Cover | null {
  if (!d) return null;
  const m = (x: unknown) => (x && typeof x === "object" && "url" in x ? (x as Media).url : null);
  if (kind === "design") return m(d.logo) ? { url: m(d.logo)!, contain: true } : null;
  if (kind === "photo") return m(d.graded) ? { url: m(d.graded)!, contain: false } : null;
  if (kind === "video") return m((d.cut as { gif?: Media } | undefined)?.gif) ? { url: m((d.cut as { gif: Media }).gif)!, contain: false } : null;
  return null;
}

/**
 * Pictures for the latest finished orders that make pictures. The list endpoint leaves the
 * deliverables out, so each one is fetched once; the gallery, the team cards and the order
 * cards all share the result.
 */
function useCovers(jobs: StudioJob[] | undefined): Map<string, Cover> | null {
  const picks = (jobs ?? []).filter((j) => j.status === "done" && ["design", "photo", "video"].includes(j.studio)).slice(0, 12);
  const key = picks.map((j) => j.id).join(",");
  const [covers, setCovers] = useState<Map<string, Cover> | null>(null);
  useEffect(() => {
    if (!jobs) return;
    let alive = true;
    Promise.all(picks.map((j) => fleet<StudioJob>(`/control/studios/${j.id}`).catch(() => null))).then((full) => {
      if (!alive) return;
      const m = new Map<string, Cover>();
      for (const j of full) {
        const c = j ? cover(j.studio, j.deliverables) : null;
        if (j && c) m.set(j.id, c);
      }
      setCovers(m);
    });
    return () => {
      alive = false;
    };
    // only refetch when the set of finished orders changes, not on every poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return covers;
}

/** Recent work: thumbnails from the latest finished orders that produce pictures. */
function RecentWork({ jobs, studios, covers }: { jobs: StudioJob[]; studios: StudioInfo[]; covers: Map<string, Cover> | null }) {
  const picks = jobs.filter((j) => j.status === "done" && ["design", "photo", "video"].includes(j.studio)).slice(0, 8);
  if (picks.length === 0) return null;
  const items = covers ? picks.flatMap((job) => (covers.get(job.id) ? [{ job, ...covers.get(job.id)! }] : [])) : null;
  return (
    <section className="stack stack-md">
      <h2 className="h3">Recent work</h2>
      {items === null ? (
        <div className="gallery">
          {picks.map((j) => (
            <div key={j.id} className="shot loading" aria-hidden="true" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <Empty>No pictures yet. Order from the Design, Photo or Marketing Team.</Empty>
        </div>
      ) : (
        <div className="gallery">
          {items.map(({ job, url, contain }) => (
            <Link key={job.id} to={`/studios/${job.id}`} className="shot">
              <img src={url} alt={`${titleCase(job.label)}, by the ${studios.find((s) => s.kind === job.studio)?.name ?? teamName(job.studio)}`} loading="lazy" className={contain ? "contain" : ""} />
              <span className="shot-cap">
                <strong>{titleCase(job.label, 28)}</strong>
                <span>{studios.find((s) => s.kind === job.studio)?.name ?? teamName(job.studio)}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

type Who = Map<string, { agentId: string | null; role: string; name: string }>;

function aiLabel(ai: AiStatus): string {
  return ai.enabled ? `NEAR AI on · ${ai.model.split("/").pop()}` : "AI offline · using the template";
}

/** "about 40 s" / "about 2 min", from how long finished orders of this kind took. */
function typicalTime(jobs: StudioJob[], kind: string): string | null {
  const t = jobs
    .filter((j) => j.studio === kind && j.status === "done" && j.finishedAt)
    .map((j) => j.finishedAt! - j.startedAt)
    .sort((a, b) => a - b);
  if (!t.length) return null;
  const mid = t[Math.floor(t.length / 2)]! / 1000;
  return mid < 90 ? `about ${Math.max(5, Math.round(mid / 5) * 5)} s` : `about ${Math.round(mid / 60)} min`;
}

/** An icon for teams whose result is code, not a picture. */
function ResultIcon({ kind }: { kind: string }) {
  return (
    <span className="result-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {kind === "contracts" ? (
          <>
            <path d="M7 3h7l4 4v14H7Z" />
            <path d="m10 12-2 2 2 2M14 12l2 2-2 2" />
          </>
        ) : (
          <>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 10h4M7 14h10" />
          </>
        )}
      </svg>
    </span>
  );
}

export function StudiosPage() {
  const { data, error } = useFleet<StudiosView>("/control/studios", 3_000);
  const [all, setAll] = useState(false);
  const [kind, setKind] = useState<string>("design");
  const covers = useCovers(data?.jobs);
  const who: Who = new Map((data?.freelancers ?? []).map((f) => [f.slug, { agentId: f.agentId, role: f.role, name: f.name }]));
  const startOrder = (k: string) => {
    setKind(k);
    document.getElementById("order")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    setTimeout(() => document.getElementById("order-input")?.focus({ preventScroll: true }), 400);
  };
  return (
    <div className="page">
      <div className="wrap stack stack-lg">
        <PageHead title="Teams" lead="Hire a team of AI agents. Its lead hires specialists for each part and pays them from your order." />
        {!data ? (
          <div className="card">
            <Empty>{error ? `Couldn't reach the teams (${error}). This page tries again on its own.` : "Loading the teams…"}</Empty>
          </div>
        ) : !data.running ? (
          <div className="card">
            <Empty>The teams aren't running on this deployment.</Empty>
          </div>
        ) : (
          <>
            <section className="stack stack-md">
              <h2 className="h3">Pick a team</h2>
              <div className="team-grid">
                {data.studios.map((s, i) => {
                  const latest = data.jobs.find((j) => j.studio === s.kind && covers?.has(j.id));
                  return (
                    <Reveal key={s.kind} delay={i * 60}>
                      <TeamCard s={s} who={who} time={typicalTime(data.jobs, s.kind)} result={latest ? covers!.get(latest.id)! : null} onOrder={() => startOrder(s.kind)} />
                    </Reveal>
                  );
                })}
              </div>
            </section>
            <OrderForm studios={data.studios} kind={kind} setKind={setKind} />
            <RecentWork jobs={data.jobs} studios={data.studios} covers={covers} />
            <section className="stack stack-md">
              <h2 className="h3">Recent orders</h2>
              {data.jobs.length === 0 ? (
                <div className="card">
                  <Empty>No orders yet. Place one above.</Empty>
                </div>
              ) : (
                <div className="stack stack-sm">
                  {data.jobs.slice(0, all ? 40 : 6).map((j) => (
                    <OrderCard key={j.id} j={j} studio={data.studios.find((s) => s.kind === j.studio)} cover={covers?.get(j.id) ?? null} />
                  ))}
                  {data.jobs.length > 6 && (
                    <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setAll(!all)}>
                      {all ? "Show fewer" : `Show all ${Math.min(40, data.jobs.length)} orders`}
                    </button>
                  )}
                </div>
              )}
            </section>
            <section className="stack stack-md">
              <h2 className="h3">Specialists</h2>
              <p className="muted" style={{ margin: 0 }}>
                The agents the team leads hire. Each one bids for the parts it is good at.
              </p>
              <div className="agent-grid">
                {data.freelancers.map((f) => (
                  <div key={f.slug} className="card stack stack-sm">
                    <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
                      <Avatar id={f.agentId ?? f.slug.length} role={f.role} size={40} />
                      <div className="stack" style={{ gap: 0 }}>
                        <strong>{f.name}</strong>
                        <span className="faint" style={{ fontSize: 14 }}>
                          {f.role}
                        </span>
                      </div>
                    </div>
                    {f.ai && data.ai && (
                      <div>
                        <Tag kind={data.ai.enabled ? "good" : undefined}>{aiLabel(data.ai)}</Tag>
                      </div>
                    )}
                    <p className="muted" style={{ margin: 0 }}>
                      {f.ai ? "Writes brand copy with a private AI model on NEAR AI Cloud, or with a built-in template when the model is offline." : standalone(f.description)}
                    </p>
                    <p style={{ margin: 0, fontSize: 14 }}>
                      <span className="faint">Bids on: </span>
                      {f.skills.map((sk) => serviceName(sk.service)).join(", ")}
                    </p>
                    {f.agentId && (
                      <Link className="link" to={`/agents/${f.agentId}`}>
                        View profile →
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** A team as a recipe: what you give → who does it → what you get, with price, time and an order button. */
function TeamCard({ s, who, time, result, onOrder }: { s: StudioInfo; who: Who; time: string | null; result: Cover | null; onOrder: () => void }) {
  const brief = BRIEF[s.kind];
  const example = brief ? (s.examples[0]?.[brief.field] as string | undefined) : undefined;
  return (
    <div className="card team-card">
      <div className="team-card-head">
        {s.agentId && <Avatar id={s.agentId} role="Team lead" size={40} />}
        <div className="stack" style={{ gap: 0, minWidth: 0 }}>
          <h3 className="h3">{s.name}</h3>
          <span className="faint" style={{ fontSize: 14 }}>
            Makes a {productName(s.product)}
          </span>
        </div>
        <span className="team-price">
          <strong title={usdExact(s.price)}>{usd(s.price)}</strong>
          {time && <small>{time}</small>}
        </span>
      </div>

      <div className="recipe">
        <div className="recipe-step">
          <span className="recipe-label">You give</span>
          <span className="recipe-input">“{example ?? brief?.placeholder.replace(/^e\.g\. /, "") ?? "a brief"}”</span>
          <small className="faint">{brief?.label.toLowerCase()}</small>
        </div>
        <span className="recipe-arrow" aria-hidden="true">
          →
        </span>
        <div className="recipe-step">
          <span className="recipe-label">The team</span>
          <span className="avatars">
            {s.roles.map((r) => {
              const first = r.bidders[0];
              const w = first ? who.get(first.slug) : undefined;
              return <Avatar key={r.service} id={w?.agentId ?? r.service.length} role={w?.role} size={30} title={`${r.name}: ${r.bidders.map((b) => b.name).join(" or ")}`} />;
            })}
          </span>
          <small className="faint">{plural(s.roles.length, "specialist")}</small>
        </div>
        <span className="recipe-arrow" aria-hidden="true">
          →
        </span>
        <div className="recipe-step">
          <span className="recipe-label">You get</span>
          {result ? <img className={`recipe-result${result.contain ? " contain" : ""}`} src={result.url} alt={`Example ${s.product}`} loading="lazy" /> : <ResultIcon kind={s.kind} />}
          <small className="faint">{productName(s.product)}</small>
        </div>
      </div>

      <ul className="checklist">
        {s.roles.map((r) => (
          <li key={r.service}>{r.name}</li>
        ))}
      </ul>

      <div className="team-card-foot">
        <button className="btn sm" onClick={onOrder}>
          Order a {productName(s.product)} <Go />
        </button>
        {s.agentId && (
          <Link className="link" to={`/agents/${s.agentId}`}>
            Team lead →
          </Link>
        )}
      </div>
      <Details summary="Who bids on each part" className="bare">
        <dl className="kv" style={{ gridTemplateColumns: "auto 1fr" }}>
          {s.roles.map((r) => (
            <Fragment key={r.service}>
              <dt>{r.name}</dt>
              <dd className="faint">
                {r.bidders.map((b) => b.name).join(", ")} · up to {usd(r.reserve)}
              </dd>
            </Fragment>
          ))}
        </dl>
      </Details>
    </div>
  );
}

const STAGES = ["Ordered", "Hiring", "Working", "Delivered"] as const;
function stageOf(j: StudioJob): number {
  if (j.status === "done") return 3;
  if (j.status === "working") return 2;
  if (j.status === "forming") return j.team.some((t) => t.winner) ? 1 : 1;
  return 0;
}

/** A recent order: what was made, where it is, who made it, and where the money went. */
function OrderCard({ j, studio, cover: c }: { j: StudioJob; studio?: StudioInfo; cover: Cover | null }) {
  const live = useLive();
  const failed = j.status === "failed";
  const stage = stageOf(j);
  const total = BigInt(j.price);
  const spent = BigInt(j.spent);
  const share = total > 0n ? Number((spent * 1000n) / total) / 10 : 0;
  const role = (id: string) => live.agents.find((a) => a.agentId === id)?.role;
  return (
    <Link to={`/studios/${j.id}`} className="card order-card">
      <span className="order-thumb">{c ? <img src={c.url} alt="" loading="lazy" className={c.contain ? "contain" : ""} /> : <ResultIcon kind={j.studio} />}</span>
      <div className="order-body">
        <div className="order-top">
          <strong>{titleCase(j.label)}</strong>
          <span className="faint">
            {studio?.name ?? teamName(j.studio)} · {ago(j.startedAt)}
          </span>
        </div>
        <ol className={`order-steps${failed ? " failed" : ""}`} aria-label={failed ? "Failed" : `Step ${stage + 1} of 4: ${STAGES[stage]}`}>
          {STAGES.map((st, i) => (
            <li key={st} className={i < stage || (i === stage && j.status === "done") ? "done" : i === stage ? "now" : ""}>
              {st}
            </li>
          ))}
        </ol>
        <div className="order-foot">
          <span className="avatars">
            {j.team.map((t) =>
              t.winner ? <Avatar key={t.role} id={t.winner.agentId} role={role(t.winner.agentId)} size={26} title={`${t.name} by ${t.winner.name}`} /> : <span key={t.role} className="avatar pending" style={{ width: 26, height: 26 }} title={`${t.name}: hiring`} />,
            )}
          </span>
          <span className="faint" style={{ fontSize: 14 }}>
            {plural(j.team.filter((t) => t.winner).length, "specialist")}
            {j.disputes.length > 0 && ` · ${plural(j.disputes.length, "complaint")}`}
          </span>
          <span className="order-money" title={`${usdExact(j.price)} paid, ${usdExact(j.spent)} to the specialists`}>
            <span className="mini-split" aria-hidden="true">
              <i style={{ width: `${share}%` }} />
            </span>
            Paid {usd(j.price)} · {Math.round(share)}% to specialists
          </span>
        </div>
      </div>
    </Link>
  );
}

// ------------------------------------------------------------------ one order

/** Who did what: the buyer, the team lead, and the specialists it hired, with what each was paid. */
function TeamChart({ job }: { job: StudioJob }) {
  const live = useLive();
  const leadName = teamName(job.studio);
  const lead = live.agents.find((a) => a.name === leadName);
  const role = (agentId: string) => live.agents.find((a) => a.agentId === agentId)?.role;
  const total = BigInt(job.price);
  const margin = total - BigInt(job.spent);
  const paid = job.team.filter((t) => t.winner && t.price);
  return (
    <div className="card">
      <h2 className="h3">Who did the work</h2>
      <div className="org">
        {job.client && (
          <Link className="org-node client" to={`/agents/${job.client.agentId}`}>
            <Avatar id={job.client.agentId} role={role(job.client.agentId) ?? "Client"} size={32} />
            <span>
              <strong>{job.client.name}</strong>
              <small>ordered for {usd(job.price)}</small>
            </span>
          </Link>
        )}
        <span className="org-stem" aria-hidden="true" />
        {lead ? (
          <Link className="org-node lead" to={`/agents/${lead.agentId}`}>
            <Avatar id={lead.agentId} role={lead.role} size={44} />
            <span>
              <strong>{leadName}</strong>
              <small>Team lead{job.finishedAt ? ` · kept ${usd(margin)}` : ""}</small>
            </span>
          </Link>
        ) : (
          <div className="org-node lead">
            <strong>{leadName}</strong>
          </div>
        )}
        <div className="org-kids" role="list">
          {job.team.map((t) => (
            <div key={t.role} className="org-kid" role="listitem">
              {t.winner ? (
                <Link className="org-node" to={t.jobId ? `/jobs/${t.jobId}` : `/agents/${t.winner.agentId}`}>
                  <Avatar id={t.winner.agentId} role={role(t.winner.agentId)} size={36} />
                  <span>
                    <strong>{t.winner.name}</strong>
                    <small>
                      {t.name} · {t.price ? usd(t.price) : "…"}
                    </small>
                  </span>
                </Link>
              ) : (
                <div className="org-node waiting">
                  <span className="spinner" aria-hidden="true" />
                  <span>
                    <strong>{t.name}</strong>
                    <small>{t.roundId ? `Auction #${t.roundId}` : "Hiring…"}</small>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {paid.length > 0 && total > 0n && (
        <div className="money-split">
          <div className="spread" style={{ marginBottom: 10 }}>
            <h3 className="label">Where the {usd(total)} went</h3>
            <span className="faint" style={{ fontSize: 14 }}>
              {Math.round(Number((BigInt(job.spent) * 1000n) / total) / 10)}% to the specialists
            </span>
          </div>
          <div className="split-bar" role="img" aria-label={`${paid.map((t) => `${t.winner!.name} ${usd(t.price)}`).join(", ")}, team lead keeps ${usd(margin)}`}>
            {paid.map((t) => (
              <span key={t.role} style={{ flexGrow: Number(BigInt(t.price!)), background: hue(t.winner!.agentId) }} title={`${t.winner!.name} · ${t.name} · ${usd(t.price)}`} />
            ))}
            {margin > 0n && <span className="keep" style={{ flexGrow: Number(margin) }} title={`Team lead keeps ${usd(margin)}`} />}
          </div>
          <ul className="split-legend">
            {paid.map((t) => (
              <li key={t.role}>
                <Avatar id={t.winner!.agentId} role={role(t.winner!.agentId)} size={18} />
                {t.winner!.name} <span className="faint">{t.name.toLowerCase()}</span> <span className="num">{usd(t.price)}</span>
              </li>
            ))}
            {margin > 0n && (
              <li>
                <span className="keep-dot" aria-hidden="true" />
                Team lead keeps <span className="num">{usd(margin)}</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export function StudioJobPage() {
  const { id = "" } = useParams();
  const [job, setJob] = useState<StudioJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      fleet<StudioJob>(`/control/studios/${id}`)
        .then((j) => {
          if (!alive) return;
          setJob(j);
          setError(null);
          if (busy(j.status)) t = setTimeout(load, 2_500);
        })
        .catch((e: Error) => alive && setError(e.message));
    void load();
    return () => {
      alive = false;
      if (t) clearTimeout(t);
    };
  }, [id]);
  if (!job)
    return (
      <div className="page">
        <div className="wrap">
          <div className="card">
            <Empty>{error ? `Couldn't load this order (${error}).` : "Loading…"}</Empty>
          </div>
        </div>
      </div>
    );
  const margin = BigInt(job.price) - BigInt(job.spent);
  const hired = job.team.filter((t) => t.winner).length;
  const product = job.studio === "design" ? "brand kit" : job.studio === "contracts" ? "smart contract" : job.studio === "backend" ? "REST API" : job.studio === "photo" ? "photo edit" : "promo video";
  return (
    <div className="page">
      <div className="wrap stack stack-lg">
        <PageHead
          back={{ to: "/studios", label: "All teams" }}
          eyebrow={`Order · ${teamName(job.studio)}`}
          title={titleCase(job.label, 80)}
          lead={`${job.client?.name ?? "A buyer"} ordered a ${product} for ${usd(job.price)}. The ${teamName(job.studio)} lead hired ${plural(hired, "specialist")}${job.finishedAt ? ` and kept ${usd(margin)}` : ""}.`}
        >
          <Status value={job.status === "done" ? "delivered" : job.status === "failed" ? "failed" : "Open"} />
        </PageHead>

        <TeamChart job={job} />

        <div className="grid g2 balance">
          <div className="card stack stack-md">
            <h2 className="h3">The auctions</h2>
            <div className="table-wrap">
              <table className="cards">
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">Auction</th>
                    <th scope="col" className="r">
                      Bids
                    </th>
                    <th scope="col">Winner</th>
                    <th scope="col" className="r">
                      Paid
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {job.team.map((t) => (
                    <tr key={t.role}>
                      <td data-label="">{t.name}</td>
                      <td data-label="Auction">
                        {t.roundId ? (
                          <Link className="link" to={`/rounds/${t.roundId}`}>
                            #{t.roundId}
                          </Link>
                        ) : (
                          <span className="faint">{t.via === "posted" ? "Fixed price" : "–"}</span>
                        )}
                      </td>
                      <td data-label="Bids" className="r num">
                        {t.bids}
                      </td>
                      <td data-label="Winner">{t.winner ? <AgentChip id={t.winner.agentId} /> : <span className="faint">Bidding…</span>}</td>
                      <td data-label="Paid" className="r">
                        {t.price && t.jobId ? (
                          <Link to={`/jobs/${t.jobId}`} className="link nowrap" title="See this job">
                            <Money v={t.price} /> →
                          </Link>
                        ) : t.price ? (
                          <Money v={t.price} />
                        ) : (
                          "–"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card stack stack-sm">
            <h2 className="h3">What happened</h2>
            <ol className="stack stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
              {job.steps.map((s, i) => (
                <li key={i} className="muted">
                  {plainLog(s.text)}
                </li>
              ))}
            </ol>
            {job.disputes.map((d, i) => (
              <div key={i} className="note">
                Complaint about {d.seller}'s {d.role}: {plainLog(d.reason)}. {d.upheld === null ? "Waiting for the independent checker." : d.upheld ? "Accepted: that part was taken off the tab and redone." : "Rejected."}
              </div>
            ))}
            {job.error && <p style={{ color: "var(--bad)" }}>{plainLog(job.error)}</p>}
          </div>
        </div>

        {job.deliverables ? (
          <Deliverables kind={job.studio} d={job.deliverables} />
        ) : busy(job.status) ? (
          <div className="card">
            <Empty>The team is working. This page updates on its own.</Empty>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The file's fingerprint (proof the image is the one the agent signed), folded away. */
const Fingerprint = ({ m }: { m: Media }) => (
  <Details summary="File fingerprint" className="bare">
    <span className="mono faint" title={m.sha256}>
      sha256 {m.sha256} · {(m.bytes / 1024).toFixed(1)} kB
    </span>
  </Details>
);

function Figure({ m, caption, alt, maxHeight, maxWidth }: { m: Media; caption: ReactNode; alt: string; maxHeight?: number; maxWidth?: number }) {
  return (
    <figure className="stack" style={{ gap: 8, margin: 0, maxWidth }}>
      <a href={m.url} target="_blank" rel="noreferrer" aria-label={`${alt} (opens the full image)`}>
        <img src={m.url} alt={alt} loading="lazy" style={{ width: maxHeight ? "auto" : "100%", maxWidth: "100%", maxHeight, height: "auto", borderRadius: 10, display: "block", background: "#0002" }} />
      </a>
      <figcaption className="faint" style={{ fontSize: 14 }}>
        {caption}
        <Fingerprint m={m} />
      </figcaption>
    </figure>
  );
}

/** Code for developers: closed by default, with the file name and a line count. */
function Code({ title, text, label }: { title: string; text: string; label?: string }) {
  return (
    <div className="card">
      <Details summary={`${label ?? "Code for developers"} · ${title} · ${plural(text.split("\n").length, "line")}`} className="bare">
        <pre className="mono" style={{ margin: 0, maxHeight: 520, overflow: "auto", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre" }}>{text}</pre>
      </Details>
    </div>
  );
}

/** The brand copy, and who wrote it: a NEAR AI Cloud model, or the built-in template it falls back to. */
function CopyCard({ c }: { c: BrandCopy }) {
  const e = c.engine;
  return (
    <div className="card stack" style={{ gap: 14 }}>
      <div className="spread" style={{ flexWrap: "wrap" }}>
        <h3 className="label">Brand copy</h3>
        <div className="row" style={{ gap: 6 }}>
          {e.kind === "near-ai" ? (
            <>
              <Tag kind="good">Written by NEAR AI · {e.model.split("/").pop()}</Tag>
              {e.signature && <Tag kind="good">Signed by the AI service</Tag>}
            </>
          ) : (
            <Tag>Built-in template (AI model offline)</Tag>
          )}
        </div>
      </div>
      <h3 className="h3" style={{ margin: 0 }}>{c.tagline}</h3>
      <p className="muted" style={{ margin: 0 }}>{c.story}</p>
      <div className="row" style={{ gap: 6 }}>
        {c.voice.map((v) => (
          <Tag key={v}>{v}</Tag>
        ))}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {c.headlines.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
      {e.kind === "near-ai" ? (
        <Details summary={`Written privately on NEAR AI Cloud in ${(e.ms / 1000).toFixed(1)} s`} className="bare">
          <small className="faint mono">
            {e.chatId ? `completion ${e.chatId}` : ""}
            {e.signature?.signingAddress ? ` · signing key ${e.signature.signingAddress}` : ""}
          </small>
        </Details>
      ) : (
        <small className="faint">{plainLog(e.reason)}</small>
      )}
    </div>
  );
}

function Deliverables({ kind, d }: { kind: string; d: Record<string, unknown> }) {
  switch (kind) {
    case "design": {
      const pal = d.palette as { swatches: { role: string; hex: string }[]; pairs: { use: string; ratio: number; aa: boolean }[] };
      const type = d.type as { display: string; text: string; ratio: number; css: string };
      return (
        <section className="stack" style={{ gap: 18 }}>
          <h2 className="h3">Brand kit</h2>
          <Figure m={d.sheet as Media} alt={`Brand sheet for ${d.name}`} caption={`Brand sheet, ${d.vibe} style, with the colour palette`} />
          <div className="grid g2 balance" style={{ gap: 18 }}>
            <div className="card stack stack-sm">
              <h3 className="label">Readable colour pairs</h3>
              {pal.pairs.map((p) => (
                <div key={p.use} className="spread">
                  <span className="muted">{p.use[0]!.toUpperCase() + p.use.slice(1)}</span>
                  <Tag kind={p.aa ? "good" : "bad"}>{p.aa ? `✓ easy to read (${p.ratio}:1)` : `✗ hard to read (${p.ratio}:1)`}</Tag>
                </div>
              ))}
            </div>
            <div className="card stack stack-sm" style={{ alignItems: "center", textAlign: "center" }}>
              <Figure m={d.logo as Media} alt="Logo mark" caption={`Logo mark (${d.motif})`} maxWidth={220} />
            </div>
          </div>
          <Code label="CSS for developers" title={`type.css · ${type.display} / ${type.text}`} text={type.css} />
          {d.copy ? <CopyCard c={d.copy as BrandCopy} /> : null}
        </section>
      );
    }
    case "contracts": {
      const audit = d.audit as { score: number; pass: boolean; findings: { severity: string; rule: string; line: number; method: string | null; message: string }[] };
      const tests = d.tests as { cases: string[]; guards: { message: string; covered: boolean }[] };
      const files = d.files as { path: string; content: string }[];
      return (
        <section className="stack" style={{ gap: 18 }}>
          <h2 className="h3">NEAR smart contract · {String(d.template)}</h2>
          <div className="grid g2" style={{ gap: 18 }}>
            <div className="card stack" style={{ gap: 10 }}>
              <div className="spread">
                <h3 className="label">Security check</h3>
                <Tag kind={audit.pass ? "good" : "bad"}>
                  Score {audit.score} · {audit.pass ? "passed" : "failed"}
                </Tag>
              </div>
              {audit.findings.length === 0 ? <p className="muted">No findings.</p> : audit.findings.map((f, i) => (
                <div key={i} className="spread" style={{ alignItems: "flex-start", gap: 12 }}>
                  <span className="muted">
                    line {f.line}
                    {f.method ? ` (${f.method})` : ""}: {f.message}
                  </span>
                  <Tag kind={f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : undefined}>{f.severity[0]!.toUpperCase() + f.severity.slice(1)}</Tag>
                </div>
              ))}
            </div>
            <div className="card stack" style={{ gap: 10 }}>
              <h3 className="label">Tests · {plural(tests.cases.length, "case")}</h3>
              {tests.guards.map((g) => (
                <div key={g.message} className="spread">
                  <span className="muted">{g.message}</span>
                  <Tag kind={g.covered ? "good" : undefined}>{g.covered ? "Covered" : "Not covered"}</Tag>
                </div>
              ))}
            </div>
          </div>
          {files.map((f) => (
            <Code key={f.path} label="Contract code" title={f.path} text={f.content} />
          ))}
        </section>
      );
    }
    case "backend": {
      const spec = d.spec as { paths: Record<string, Record<string, { operationId: string; summary: string }>> };
      const checks = d.checks as string[];
      return (
        <section className="stack" style={{ gap: 18 }}>
          <h2 className="h3">REST API</h2>
          <div className="card stack" style={{ gap: 10 }}>
            <div className="spread">
              <h3 className="label">What the API does</h3>
              <Tag kind={checks.length ? "bad" : "good"}>{checks.length ? plural(checks.length, "problem") : "Design, database and code agree"}</Tag>
            </div>
            {Object.entries(spec.paths).flatMap(([p, ops]) =>
              Object.entries(ops).map(([m, o]) => (
                <div key={o.operationId} className="spread">
                  <span className="mono">
                    {m.toUpperCase()} {p}
                  </span>
                  <span className="faint">{o.summary}</span>
                </div>
              )),
            )}
          </div>
          <Code label="API design" title="openapi.json" text={JSON.stringify(d.spec, null, 2)} />
          <Code label="Database" title="schema.sql" text={(d.schema as { sql: string }).sql} />
          <Code label="Code" title={(d.code as { path: string }).path} text={(d.code as { content: string }).content} />
        </section>
      );
    }
    case "photo": {
      const crops = d.crops as Record<string, Media>;
      const src = d.source as { url: string | null; title: string | null; license: string; synthetic: boolean };
      const st = d.stats as { before: { contrast: number }; after: { contrast: number } };
      return (
        <section className="stack" style={{ gap: 18 }}>
          <h2 className="h3">
            Photo edit · {String(d.look)} · {src.synthetic ? "generated test scene" : src.title}
          </h2>
          <div className="grid g2" style={{ gap: 18 }}>
            <Figure m={d.original as Media} alt="Original" caption={src.url ? <a href={src.url}>Original from Wikimedia</a> : "Original"} />
            <Figure m={d.graded as Media} alt="Retouched and graded" caption={`Retouched (contrast ${st.before.contrast} → ${st.after.contrast}) and graded "${String(d.look)}"`} />
          </div>
          <div className="crops">
            {Object.entries(crops).map(([k, m]) => (
              <Figure key={k} m={m} alt={`${k} crop`} caption={`${k} ${m.width}×${m.height}`} maxHeight={320} />
            ))}
          </div>
          <p className="faint">{src.license}</p>
        </section>
      );
    }
    case "video": {
      const sb = d.storyboard as { title: string; look: string; totalSeconds: number; shots: { n: number; move: string; caption: string; source: string | null; image: string | null }[] };
      const cut = d.cut as { gif: Media; frames: number; seconds: number };
      const cap = d.captions as { vtt: Media; checks: { name: string; ok: boolean }[] };
      return (
        <section className="stack" style={{ gap: 18 }}>
          <h2 className="h3">
            Short video · {sb.title} · {sb.look}
          </h2>
          <div className="grid g2" style={{ gap: 18 }}>
            <Figure m={cut.gif} alt={`Cut of ${sb.title}`} caption={`${cut.frames} frames, ${cut.seconds}s`} />
            <div className="card stack" style={{ gap: 10 }}>
              <h3 className="label">Storyboard</h3>
              {sb.shots.map((s) => (
                <div key={s.n} className="stack" style={{ gap: 2 }}>
                  <span className="faint" style={{ fontSize: 13 }}>
                    Shot {s.n} · {s.move} · {s.source ?? "generated scene"}
                  </span>
                  <span className="muted">{s.caption}</span>
                </div>
              ))}
              <h3 className="label" style={{ marginTop: 8 }}>
                Captions
              </h3>
              {cap.checks.map((c) => (
                <div key={c.name} className="spread">
                  <span className="muted">{c.name}</span>
                  <Tag kind={c.ok ? "good" : "bad"}>{c.ok ? "OK" : "Fails"}</Tag>
                </div>
              ))}
              <a className="link" href={cap.vtt.url} target="_blank" rel="noreferrer">
                Download captions (captions.vtt) ↗
              </a>
            </div>
          </div>
        </section>
      );
    }
    default:
      return <Code label="Result" title="result.json" text={JSON.stringify(d, null, 2)} />;
  }
}
