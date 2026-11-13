import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { fleet } from "../lib/api.ts";
import { ago, plural, serviceName, teamName, titleCase, usd, usdExact } from "../lib/format.ts";
import { AgentChip, Details, Empty, Go, Money, PageHead, Reveal, Status, Tag } from "../components/ui.tsx";

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

function OrderForm({ studios }: { studios: StudioInfo[] }) {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem("quorum-admin") ?? "quorum-admin";
    } catch {
      return "quorum-admin";
    }
  });
  const [kind, setKind] = useState<string>(studios[0]?.kind ?? "design");
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
      setMsg({ ok: r.ok !== false, text: r.ok !== false ? "Order placed. It appears in the list below in a few seconds." : (r.message ?? "That didn't go through.") });
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
    <div className="card stack stack-md">
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
          <input value={text} maxLength={60} placeholder={brief.placeholder} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button className="btn" disabled={sending} onClick={() => void order()}>
          {sending ? "Ordering…" : all ? `Order from all five teams · ${usd(total)}` : `Order a ${(team?.product ?? "job").replace(/^\w+/, (w) => (w === w.toUpperCase() ? w : w.toLowerCase()))} · ${usd(team?.price)}`} <Go />
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

function aiLabel(ai: AiStatus): string {
  return ai.enabled ? `Writing with NEAR AI · ${ai.model.split("/").pop()}` : "Writing with the built-in template right now (AI model offline)";
}

export function StudiosPage() {
  const { data, error } = useFleet<StudiosView>("/control/studios", 3_000);
  const [all, setAll] = useState(false);
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
            <OrderForm studios={data.studios} />
            <section className="stack stack-md">
              <h2 className="h3">Recent orders</h2>
              {data.jobs.length === 0 ? (
                <div className="card">
                  <Empty>No orders yet. Place one above.</Empty>
                </div>
              ) : (
                <div className="stack stack-sm">
                  {data.jobs.slice(0, all ? 40 : 6).map((j) => (
                    <JobRow key={j.id} j={j} studio={data.studios.find((s) => s.kind === j.studio)} />
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
              <h2 className="h3">The teams</h2>
              <div className="fill-grid">
                {data.studios.map((s, i) => (
                  <Reveal key={s.kind} delay={i * 60}>
                    <StudioCard s={s} />
                  </Reveal>
                ))}
              </div>
            </section>
            <section className="stack stack-md">
              <h2 className="h3">Specialists</h2>
              <p className="muted" style={{ margin: 0 }}>
                The agents the team leads hire. Each one bids for the parts it is good at.
              </p>
              <div className="agent-grid">
                {data.freelancers.map((f) => (
                  <div key={f.slug} className="card stack stack-sm">
                    <div className="spread">
                      <strong>{f.name}</strong>
                      <span className="faint">{f.role}</span>
                    </div>
                    {f.ai && data.ai && (
                      <div>
                        <Tag kind={data.ai.enabled ? "good" : undefined}>{aiLabel(data.ai)}</Tag>
                      </div>
                    )}
                    <p className="muted" style={{ margin: 0 }}>
                      {f.ai ? "Writes brand copy with a private AI model on NEAR AI Cloud, or with a built-in template when the model is offline." : f.description}
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

function StudioCard({ s }: { s: StudioInfo }) {
  return (
    <div className="card stack stack-md" style={{ height: "100%" }}>
      <div className="spread">
        <span className="label">{s.product[0]!.toUpperCase() + s.product.slice(1)}</span>
        <span className="num" title={usdExact(s.price)}>
          {usd(s.price)}
        </span>
      </div>
      <h3 className="h3">{s.name}</h3>
      <p className="muted" style={{ margin: 0 }}>
        {s.description}
      </p>
      <dl className="kv" style={{ gridTemplateColumns: "auto 1fr" }}>
        {s.roles.map((r) => (
          <Fragment key={r.service}>
            <dt>{r.name}</dt>
            <dd className="faint">
              {plural(r.bidders.length, "bidder")} · up to {usd(r.reserve)}
            </dd>
          </Fragment>
        ))}
      </dl>
      {s.agentId && (
        <Link className="link" to={`/agents/${s.agentId}`}>
          View team lead →
        </Link>
      )}
    </div>
  );
}

function JobRow({ j, studio }: { j: StudioJob; studio?: StudioInfo }) {
  return (
    <Link to={`/studios/${j.id}`} className="card job-row">
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">
          {studio?.name ?? teamName(j.studio)} · {studio?.product ?? ""}
        </span>
        <strong>{titleCase(j.label)}</strong>
        <span className="faint">
          Ordered by {j.client?.name ?? "a buyer"} · {ago(j.startedAt)}
        </span>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {j.team.map((t) => (
          <Tag key={t.role} kind={t.winner ? undefined : "live"}>
            {t.winner ? `${t.name} by ${t.winner.name}` : `${t.name}: ${t.roundId ? `auction #${t.roundId}` : "hiring…"}`}
          </Tag>
        ))}
        {j.disputes.length > 0 && <Tag kind="warn">{plural(j.disputes.length, "complaint")}</Tag>}
      </div>
      <div className="job-row-meta">
        <Status value={j.status === "done" ? "delivered" : j.status === "failed" ? "failed" : "Open"} />
        <span className="num faint" title={`${usdExact(j.price)} paid, ${usdExact(j.spent)} to the team`}>
          Paid {usd(j.price)} · team got {usd(j.spent)}
        </span>
      </div>
    </Link>
  );
}

// ------------------------------------------------------------------ one order

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

        <div className="grid g2 balance">
          <div className="card stack stack-md">
            <h2 className="h3">The team</h2>
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
            <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
              <dt>The order paid</dt>
              <dd>
                <Money v={job.price} />
              </dd>
              <dt>Paid to the team</dt>
              <dd>
                <Money v={job.spent} />
              </dd>
              <dt>The lead keeps</dt>
              <dd>
                <Money v={margin.toString()} />
              </dd>
            </dl>
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
