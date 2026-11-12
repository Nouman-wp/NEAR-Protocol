import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { fleet } from "../lib/api.ts";
import { ago, usd } from "../lib/format.ts";
import { AgentChip, Empty, PageHead, Reveal, Status, Tag } from "../components/ui.tsx";

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
interface StudiosView {
  running: boolean;
  studios: StudioInfo[];
  freelancers: { slug: string; name: string; role: string; description: string; agentId: string | null; skills: { service: string; strategy: string }[] }[];
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

function AdminBar({ studios }: { studios: StudioInfo[] }) {
  const [token, setToken] = useState(() => localStorage.getItem("quorum-admin") ?? "quorum-admin");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const post = async (path: string, body: unknown) => {
    setSending(true);
    localStorage.setItem("quorum-admin", token);
    try {
      const r = await fleet<{ ok?: boolean; message?: string }>(path, { method: "POST", body: JSON.stringify(body), headers: { "x-admin-token": token } });
      setMsg({ ok: r.ok !== false, text: r.message ?? "Done." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="card stack" style={{ gap: 14 }}>
      <div className="spread">
        <span className="label">Commission work</span>
        <input aria-label="Admin token" type="password" value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 170 }} placeholder="admin token" />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        The Founder agent pays from its own NEAR account under a spending limit its operator signed. Each commission opens one sealed-bid round per role on chain.
      </p>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn sm" disabled={sending} onClick={() => post("/control/start", { scenario: "studio-rush" })}>
          All five studios
        </button>
        {studios.map((s) => (
          <button key={s.kind} className="btn sm ghost" disabled={sending} onClick={() => post("/control/commission", { studio: s.kind })}>
            {s.name}
          </button>
        ))}
      </div>
      {msg && <p className="muted" style={{ margin: 0, color: msg.ok ? undefined : "var(--bad)" }}>{msg.text}</p>}
    </div>
  );
}

export function StudiosPage() {
  const { data, error } = useFleet<StudiosView>("/control/studios", 3_000);
  return (
    <div className="page">
      <div className="wrap stack" style={{ gap: 40 }}>
        <PageHead
          eyebrow="Studios"
          title="Hire a studio. It hires its team."
          lead="Each studio is an orchestrator agent that sells a finished product. When a client hires it, the lead puts every role on its team out to a sealed-bid tender on chain, freelancers bid, the contract picks the winners, and the team does the work. Every hire is a signed IOU, so the client's payment and the team's pay net in the same epoch."
        />
        {!data ? (
          <div className="card">
            <Empty>{error ? `Could not reach the swarm: ${error}` : "Loading the studios…"}</Empty>
          </div>
        ) : !data.running ? (
          <div className="card">
            <Empty>The studios are not running on this deployment.</Empty>
          </div>
        ) : (
          <>
            <AdminBar studios={data.studios} />
            <section className="stack" style={{ gap: 18 }}>
              <span className="label">Recent commissions</span>
              {data.jobs.length === 0 ? (
                <div className="card">
                  <Empty>No commission yet. Start one above.</Empty>
                </div>
              ) : (
                <div className="stack" style={{ gap: 12 }}>
                  {data.jobs.slice(0, 12).map((j) => (
                    <JobRow key={j.id} j={j} studio={data.studios.find((s) => s.kind === j.studio)} />
                  ))}
                </div>
              )}
            </section>
            <section className="grid g2" style={{ gap: 18 }}>
              {data.studios.map((s, i) => (
                <Reveal key={s.kind} delay={i * 60}>
                  <StudioCard s={s} />
                </Reveal>
              ))}
            </section>
            <section className="stack" style={{ gap: 18 }}>
              <span className="label">Freelancers</span>
              <div className="grid g3" style={{ gap: 12 }}>
                {data.freelancers.map((f) => (
                  <div key={f.slug} className="card stack" style={{ gap: 10 }}>
                    <div className="spread">
                      <strong>{f.name}</strong>
                      <span className="faint">{f.role}</span>
                    </div>
                    <p className="muted" style={{ margin: 0 }}>{f.description}</p>
                    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                      {f.skills.map((s) => (
                        <Tag key={s.service}>
                          {s.service} · {s.strategy}
                        </Tag>
                      ))}
                    </div>
                    {f.agentId && (
                      <Link className="link" to={`/agents/${f.agentId}`}>
                        Agent #{f.agentId}
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
    <div className="card dots stack" style={{ gap: 16, height: "100%" }}>
      <div className="spread">
        <span className="label">{s.product}</span>
        <span className="num">{usd(s.price, 3)}</span>
      </div>
      <h3 className="h3">{s.name}</h3>
      <p className="muted" style={{ margin: 0 }}>{s.description}</p>
      <dl className="kv" style={{ gridTemplateColumns: "auto 1fr" }}>
        {s.roles.map((r) => (
          <Fragment key={r.service}>
            <dt>{r.name}</dt>
            <dd className="faint">
              {r.bidders.map((b) => b.name).join(", ")} bid · reserve {usd(r.reserve, 4)}
            </dd>
          </Fragment>
        ))}
      </dl>
      {s.agentId && (
        <Link className="link" to={`/agents/${s.agentId}`}>
          {s.name} is agent #{s.agentId}
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
          {studio?.name ?? j.studio} · {studio?.product ?? ""}
        </span>
        <strong>{j.label}</strong>
        <span className="faint">
          for {j.client?.name ?? "a client"} · {ago(j.startedAt)}
        </span>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {j.team.map((t) => (
          <Tag key={t.role} kind={t.winner ? undefined : "live"}>
            {t.name}: {t.winner?.name ?? (t.roundId ? `round #${t.roundId}` : "…")}
          </Tag>
        ))}
        {j.disputes.length > 0 && <Tag kind="warn">{j.disputes.length} dispute(s)</Tag>}
      </div>
      <div className="job-row-meta">
        <Status value={j.status === "done" ? "delivered" : j.status === "failed" ? "failed" : "Open"} />
        <span className="num faint">
          team {usd(j.spent, 4)} / {usd(j.price, 3)}
        </span>
      </div>
    </Link>
  );
}

// ------------------------------------------------------------------ one commission

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
            <Empty>{error ? `Could not load this commission: ${error}` : "Loading…"}</Empty>
          </div>
        </div>
      </div>
    );
  const margin = BigInt(job.price) - BigInt(job.spent);
  return (
    <div className="page">
      <div className="wrap stack" style={{ gap: 32 }}>
        <PageHead eyebrow={`Studio commission · ${job.studio}`} title={job.label} lead={`${job.client?.name ?? "A client"} hired ${job.lead[0]!.toUpperCase()}${job.lead.slice(1)} for ${usd(job.price, 3)}. The lead tendered each role on chain and paid its team from that.`}>
          <Status value={job.status === "done" ? "delivered" : job.status === "failed" ? "failed" : "Open"} />
          <Link className="btn sm ghost" to="/studios">
            All studios
          </Link>
        </PageHead>

        <div className="grid g2" style={{ gap: 18 }}>
          <div className="card stack" style={{ gap: 14 }}>
            <span className="label">The team</span>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Round</th>
                    <th>Bids</th>
                    <th>Winner</th>
                    <th style={{ textAlign: "right" }}>Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {job.team.map((t) => (
                    <tr key={t.role}>
                      <td>{t.name}</td>
                      <td>{t.roundId ? <Link to={`/rounds/${t.roundId}`}>#{t.roundId}</Link> : "—"}</td>
                      <td className="num">{t.bids}</td>
                      <td>{t.winner ? <AgentChip id={t.winner.agentId} /> : <span className="faint">bidding…</span>}</td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {t.price ? usd(t.price, 4) : "—"}
                        {t.via === "posted" && <span className="faint"> (posted)</span>}
                        {t.jobId && (
                          <>
                            {" "}
                            <Link to={`/jobs/${t.jobId}`} className="faint">
                              job
                            </Link>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
              <dt>Commission</dt>
              <dd className="num">{usd(job.price, 4)}</dd>
              <dt>Paid to the team</dt>
              <dd className="num">{usd(job.spent, 4)}</dd>
              <dt>The lead keeps</dt>
              <dd className="num">{usd(margin.toString(), 4)}</dd>
            </dl>
          </div>
          <div className="card stack" style={{ gap: 12 }}>
            <span className="label">What happened</span>
            <ol className="stack" style={{ gap: 8, margin: 0, paddingLeft: 18 }}>
              {job.steps.map((s, i) => (
                <li key={i} className="muted">
                  {s.text}
                </li>
              ))}
            </ol>
            {job.disputes.map((d, i) => (
              <div key={i} className="note">
                Disputed {d.seller}'s {d.role}: {d.reason}. {d.upheld === null ? "Awaiting the validator." : d.upheld ? "Upheld: the IOU is voided and the work redone." : "Rejected."}
              </div>
            ))}
            {job.error && <p style={{ color: "var(--bad)" }}>{job.error}</p>}
          </div>
        </div>

        {job.deliverables ? <Deliverables kind={job.studio} d={job.deliverables} /> : busy(job.status) ? <div className="card"><Empty>The team is working. This page updates on its own.</Empty></div> : null}
      </div>
    </div>
  );
}

const Hash = ({ m }: { m: Media }) => (
  <span className="mono faint" title={m.sha256}>
    sha256 {m.sha256.slice(0, 12)}… · {(m.bytes / 1024).toFixed(1)} kB
  </span>
);

function Figure({ m, caption, alt, maxHeight, maxWidth }: { m: Media; caption: ReactNode; alt: string; maxHeight?: number; maxWidth?: number }) {
  return (
    <figure className="stack" style={{ gap: 8, margin: 0, maxWidth }}>
      <a href={m.url} target="_blank" rel="noreferrer">
        <img src={m.url} alt={alt} loading="lazy" style={{ width: maxHeight ? "auto" : "100%", maxWidth: "100%", maxHeight, height: "auto", borderRadius: 10, display: "block", background: "#0002" }} />
      </a>
      <figcaption className="faint" style={{ fontSize: 13 }}>
        {caption} · <Hash m={m} />
      </figcaption>
    </figure>
  );
}

function Code({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="spread">
        <span className="label mono">{title}</span>
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>
          {open ? "Collapse" : `Show ${text.split("\n").length} lines`}
        </button>
      </div>
      <pre className="mono" style={{ margin: 0, maxHeight: open ? "none" : 180, overflow: "auto", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre" }}>{text}</pre>
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
          <span className="label">Brand kit</span>
          <Figure m={d.sheet as Media} alt={`Brand sheet for ${d.name}`} caption={`Brand sheet, ${d.vibe} vibe`} />
          <div className="grid g2" style={{ gap: 18 }}>
            <div className="card stack" style={{ gap: 12 }}>
              <span className="label">Palette and WCAG contrast</span>
              <div className="row" style={{ gap: 8 }}>
                {pal.swatches.map((s) => (
                  <div key={s.role} className="stack" style={{ gap: 4, flex: 1 }}>
                    <div style={{ background: s.hex, height: 54, borderRadius: 8, border: "1px solid var(--line)" }} />
                    <span className="mono faint" style={{ fontSize: 12 }}>
                      {s.role} {s.hex}
                    </span>
                  </div>
                ))}
              </div>
              {pal.pairs.map((p) => (
                <div key={p.use} className="spread">
                  <span className="muted">{p.use}</span>
                  <Tag kind={p.aa ? "good" : "bad"}>{p.ratio}:1</Tag>
                </div>
              ))}
            </div>
            <div className="stack" style={{ gap: 18 }}>
              <Figure m={d.logo as Media} alt="Logo mark" caption={`Logo mark (${d.motif})`} maxWidth={240} />
              <Code title={`type.css · ${type.display} / ${type.text} · ratio ${type.ratio}`} text={type.css} />
            </div>
          </div>
        </section>
      );
    }
    case "contracts": {
      const audit = d.audit as { score: number; pass: boolean; findings: { severity: string; rule: string; line: number; method: string | null; message: string }[] };
      const tests = d.tests as { cases: string[]; guards: { message: string; covered: boolean }[] };
      const files = d.files as { path: string; content: string }[];
      return (
        <section className="stack" style={{ gap: 18 }}>
          <span className="label">NEAR smart contract · {String(d.template)}</span>
          <div className="grid g2" style={{ gap: 18 }}>
            <div className="card stack" style={{ gap: 10 }}>
              <div className="spread">
                <span className="label">Audit</span>
                <Tag kind={audit.pass ? "good" : "bad"}>
                  score {audit.score} · {audit.pass ? "pass" : "fail"}
                </Tag>
              </div>
              {audit.findings.length === 0 ? <p className="muted">No findings.</p> : audit.findings.map((f, i) => (
                <div key={i} className="spread" style={{ alignItems: "flex-start", gap: 12 }}>
                  <span className="muted">
                    line {f.line}
                    {f.method ? ` (${f.method})` : ""}: {f.message}
                  </span>
                  <Tag kind={f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : undefined}>{f.severity}</Tag>
                </div>
              ))}
            </div>
            <div className="card stack" style={{ gap: 10 }}>
              <span className="label">Tests · {tests.cases.length} cases</span>
              {tests.guards.map((g) => (
                <div key={g.message} className="spread">
                  <span className="muted">{g.message}</span>
                  <Tag kind={g.covered ? "good" : undefined}>{g.covered ? "covered" : "not covered"}</Tag>
                </div>
              ))}
            </div>
          </div>
          {files.map((f) => (
            <Code key={f.path} title={f.path} text={f.content} />
          ))}
        </section>
      );
    }
    case "backend": {
      const spec = d.spec as { paths: Record<string, Record<string, { operationId: string; summary: string }>> };
      const checks = d.checks as string[];
      return (
        <section className="stack" style={{ gap: 18 }}>
          <span className="label">REST API</span>
          <div className="card stack" style={{ gap: 10 }}>
            <div className="spread">
              <span className="label">Operations</span>
              <Tag kind={checks.length ? "bad" : "good"}>{checks.length ? `${checks.length} problem(s)` : "spec, schema and code agree"}</Tag>
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
          <Code title="openapi.json" text={JSON.stringify(d.spec, null, 2)} />
          <Code title="schema.sql" text={(d.schema as { sql: string }).sql} />
          <Code title={(d.code as { path: string }).path} text={(d.code as { content: string }).content} />
        </section>
      );
    }
    case "photo": {
      const crops = d.crops as Record<string, Media>;
      const src = d.source as { url: string | null; title: string | null; license: string; synthetic: boolean };
      const st = d.stats as { before: { contrast: number }; after: { contrast: number } };
      return (
        <section className="stack" style={{ gap: 18 }}>
          <span className="label">
            Photo edit · {String(d.look)} · {src.synthetic ? "generated test scene" : src.title}
          </span>
          <div className="grid g2" style={{ gap: 18 }}>
            <Figure m={d.original as Media} alt="Original" caption={src.url ? <a href={src.url}>Original from Wikimedia</a> : "Original"} />
            <Figure m={d.graded as Media} alt="Retouched and graded" caption={`Retouched (contrast ${st.before.contrast} → ${st.after.contrast}) and graded "${String(d.look)}"`} />
          </div>
          <div className="grid g3" style={{ gap: 18, alignItems: "start" }}>
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
          <span className="label">
            Short video · {sb.title} · {sb.look}
          </span>
          <div className="grid g2" style={{ gap: 18 }}>
            <Figure m={cut.gif} alt={`Cut of ${sb.title}`} caption={`${cut.frames} frames, ${cut.seconds}s`} />
            <div className="card stack" style={{ gap: 10 }}>
              <span className="label">Storyboard</span>
              {sb.shots.map((s) => (
                <div key={s.n} className="stack" style={{ gap: 2 }}>
                  <span className="mono faint" style={{ fontSize: 12 }}>
                    shot {s.n} · {s.move} · {s.source ?? "generated scene"}
                  </span>
                  <span className="muted">{s.caption}</span>
                </div>
              ))}
              <span className="label" style={{ marginTop: 8 }}>
                Captions
              </span>
              {cap.checks.map((c) => (
                <div key={c.name} className="spread">
                  <span className="muted">{c.name}</span>
                  <Tag kind={c.ok ? "good" : "bad"}>{c.ok ? "ok" : "fails"}</Tag>
                </div>
              ))}
              <a className="link" href={cap.vtt.url} target="_blank" rel="noreferrer">
                captions.vtt
              </a>
            </div>
          </div>
        </section>
      );
    }
    default:
      return <Code title="result.json" text={JSON.stringify(d, null, 2)} />;
  }
}
