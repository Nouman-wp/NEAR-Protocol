import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { NearRpc, type AgentSummary, type IntentView, type JobView, type SettlementView } from "@quorum/core";
import { authed, authoriseSpending, connectWallet, network, signInWithDevWallet, signInWithWallet, signOut, useAccount, walletsSupported } from "../lib/account.ts";
import { agentName, useLive } from "../lib/api.ts";
import { ago, usd } from "../lib/format.ts";
import { Account, AgentChip, Empty, PageHead, Status, Tag, Tx } from "../components/ui.tsx";

interface Me {
  user: { accountId: string; displayName: string | null; createdAt: number; lastLoginAt: number; logins: number };
  agents: AgentSummary[];
  intents: IntentView[];
}
interface Hosted {
  slug: string;
  name: string;
  agentId: string | null;
  account: string;
  ready: boolean;
  createdAt: number;
}
interface Activity {
  jobs: JobView[];
  settlements: SettlementView[];
  totals: { bought: string; sold: string; jobs: number };
}
interface Commission {
  id: string;
  studio: string;
  label: string;
  status: string;
  startedAt: number;
  price: string;
  spent: string;
  client: { agentId: string; name: string } | null;
  team: { role: string; name: string; winner: { name: string } | null; roundId: number | null }[];
}

const STUDIOS = [
  { kind: "design", name: "Atelier · brand kit", field: "name", placeholder: "Brand name, e.g. Chai Point", extra: { vibe: "warm" } },
  { kind: "contracts", name: "Forge · NEAR contract", field: "name", placeholder: "Contract name, e.g. Bazaar Escrow", extra: { template: "escrow" } },
  { kind: "backend", name: "Foundry · REST API", field: "resource", placeholder: "Resource, e.g. booking", extra: {} },
  { kind: "photo", name: "Darkroom · photo edit", field: "topic", placeholder: "Wikipedia topic, e.g. Hampi", extra: { look: "film" } },
  { kind: "video", name: "Cutroom · short video", field: "topic", placeholder: "Wikipedia topic, e.g. Kerala backwaters", extra: { shots: 4, look: "film" } },
] as const;

const busyStatus = (s: string) => s === "forming" || s === "working";

export default function Dashboard() {
  const acc = useAccount();
  const [net, setNet] = useState<{ key: string; name: string; rpc: string } | null>(null);
  useEffect(() => {
    network().then(setNet, () => undefined);
  }, []);

  if (!acc.session) return <SignIn net={net} />;
  return <Signed net={net} />;
}

// ------------------------------------------------------------------ signing in

function SignIn({ net }: { net: { key: string; name: string } | null }) {
  const acc = useAccount();
  const wallets = net ? walletsSupported(net.key) : true;
  return (
    <div className="page">
      <div className="wrap stack" style={{ gap: 32 }}>
        <PageHead
          eyebrow="Dashboard"
          title="Your agents, your limits, your receipts."
          lead="Sign in with a NEAR wallet to launch agents you operate, sign the spending limits they buy under, commission the studios, and follow every job, debt and settlement that is yours."
        />
        <div className="grid g2" style={{ gap: 18 }}>
          <div className="card stack" style={{ gap: 18 }}>
            <span className="label">{acc.connected ? "Wallet connected" : "Sign in"}</span>
            {wallets ? (
              acc.connected ? (
                <>
                  <h3 className="h3">{acc.connected}</h3>
                  <p className="muted" style={{ margin: 0 }}>
                    Sign one short message to prove the account is yours. It is not a transaction and costs nothing. The first sign-in creates your Quorum profile.
                  </p>
                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <button className="btn" disabled={!!acc.busy} onClick={() => void signInWithWallet()}>
                      Sign in as {acc.connected}
                    </button>
                    <button className="btn ghost" disabled={!!acc.busy} onClick={() => void connectWallet()}>
                      Use another wallet
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="h3">Connect a NEAR wallet</h3>
                  <p className="muted" style={{ margin: 0 }}>
                    MyNearWallet, Meteor and HERE work on {net?.name ?? "NEAR testnet"}. New to testnet? Create an account at{" "}
                    <a className="link" href="https://testnet.mynearwallet.com" target="_blank" rel="noreferrer">
                      testnet.mynearwallet.com
                    </a>
                    .
                  </p>
                  <button className="btn" style={{ alignSelf: "flex-start" }} disabled={!!acc.busy} onClick={() => void connectWallet()}>
                    Connect wallet
                  </button>
                </>
              )
            ) : (
              <>
                <h3 className="h3">Local sandbox</h3>
                <p className="muted" style={{ margin: 0 }}>
                  NEAR wallets do not reach a local sandbox. The dev wallet makes a key in this browser and an account for it on the sandbox; sign-in and spending limits then go through exactly the same checks as a real wallet.
                </p>
                <button className="btn" style={{ alignSelf: "flex-start" }} disabled={!!acc.busy} onClick={() => void signInWithDevWallet()}>
                  Sign in with a dev wallet
                </button>
              </>
            )}
            {acc.busy && <p className="muted" style={{ margin: 0 }}>{acc.busy}</p>}
            {acc.error && <p style={{ margin: 0, color: "var(--bad)" }}>{acc.error}</p>}
          </div>
          <div className="card stack" style={{ gap: 14 }}>
            <span className="label">What signing in gives you</span>
            {[
              ["Agents you operate", "Launch hosted agents. Each is its own NEAR sub-account, registered on chain with your account as its operator."],
              ["Limits you sign", "An agent spends only under an intent you sign in your wallet: budget, per-job cap, deadline. The clearing service checks your key on chain."],
              ["Studios on call", "Have your agent commission a brand kit, a contract, an API, a photo edit or a video, and watch the studio tender its team."],
              ["Every receipt", "Jobs bought and sold, net debts, and the NEAR Intents settlements that paid them, with explorer links."],
            ].map(([t, d]) => (
              <div key={t} className="stack" style={{ gap: 4 }}>
                <strong>{t}</strong>
                <span className="muted">{d}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ signed in

function Signed({ net }: { net: { key: string; name: string; rpc: string } | null }) {
  const acc = useAccount();
  const live = useLive();
  const session = acc.session!;
  const [me, setMe] = useState<Me | null>(null);
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [near, setNear] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [m, h, a, c] = await Promise.all([
          authed<Me>("api", "/v1/me"),
          authed<Hosted[]>("fleet", "/users/me/agents").catch(() => [] as Hosted[]),
          authed<Activity>("api", "/v1/me/activity"),
          authed<Commission[]>("fleet", "/users/me/commissions").catch(() => [] as Commission[]),
        ]);
        if (!alive) return;
        setMe(m);
        setHosted(h);
        setActivity(a);
        setCommissions(c);
        setError(null);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tick, session.token]);

  useEffect(() => {
    if (!net) return;
    new NearRpc(net.rpc)
      .account(session.accountId)
      .then((a) => setNear(a ? (Number(a.amount / 10n ** 21n) / 1000).toFixed(3) : "0"))
      .catch(() => setNear(null));
  }, [net, session.accountId]);

  const name = me?.user.displayName || session.accountId;
  const agents = me?.agents ?? [];
  const ids = new Set(agents.map((a) => a.agentId));
  return (
    <div className="page">
      <div className="wrap stack" style={{ gap: 32 }}>
        <PageHead
          eyebrow={session.created ? "Welcome to Quorum" : "Dashboard"}
          title={`Hello, ${name}`}
          lead={session.created ? "Your profile is created. Launch an agent below, sign its spending limit, and put it to work." : "Your agents, the limits you signed for them, and everything they bought and sold."}
        >
          <button className="btn sm ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </PageHead>
        {error && <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}

        <div className="grid g4" style={{ gap: 14 }}>
          <div className="card light stat">
            <span className="label">Signed in as</span>
            <strong className="mono" style={{ wordBreak: "break-all" }}>{session.accountId}</strong>
            <small>{session.via === "dev" ? "dev wallet (local sandbox)" : "NEAR wallet"} · {near !== null ? `${near} NEAR` : "balance unavailable"}</small>
          </div>
          <div className="card stat">
            <span className="label">Agents you operate</span>
            <span className="num" style={{ fontSize: 34 }}>{agents.length}</span>
          </div>
          <div className="card stat">
            <span className="label">Your agents bought</span>
            <span className="num" style={{ fontSize: 34 }}>{usd(activity?.totals.bought ?? "0", 3)}</span>
          </div>
          <div className="card stat">
            <span className="label">Jobs either way</span>
            <span className="num" style={{ fontSize: 34 }}>{activity?.totals.jobs ?? 0}</span>
          </div>
        </div>

        <Profile me={me} onSaved={reload} />

        <section className="stack" style={{ gap: 16 }}>
          <div className="spread">
            <span className="label">Your agents</span>
          </div>
          {agents.length === 0 && hosted.length === 0 ? (
            <div className="card">
              <Empty>You do not operate an agent yet. Launch one below: it gets its own NEAR account and some test USDC to trade with.</Empty>
            </div>
          ) : (
            <div className="grid g2" style={{ gap: 14 }}>
              {agents.map((a) => (
                <AgentCard key={a.agentId} a={a} hosted={hosted.find((h) => h.agentId === a.agentId)} intents={(me?.intents ?? []).filter((i) => i.buyer === a.agentId)} onChange={reload} />
              ))}
              {hosted
                .filter((h) => !h.agentId || !ids.has(h.agentId))
                .map((h) => (
                  <div key={h.slug} className="card stack" style={{ gap: 8 }}>
                    <strong>{h.name}</strong>
                    <span className="muted">Registering {h.account} on chain…</span>
                  </div>
                ))}
            </div>
          )}
          <Launch count={hosted.length} onLaunched={reload} />
        </section>

        <section className="stack" style={{ gap: 16 }}>
          <span className="label">Studio commissions</span>
          {commissions.length === 0 ? (
            <div className="card">
              <Empty>None yet. Sign a spending limit for an agent, then commission a studio from its card.</Empty>
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {commissions.map((c) => (
                <Link key={c.id} to={`/studios/${c.id}`} className="card spread" style={{ gap: 18, flexWrap: "wrap" }}>
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="label">
                      {c.studio} · for {c.client?.name ?? "your agent"} · {ago(c.startedAt)}
                    </span>
                    <strong>{c.label}</strong>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {c.team.map((t) => (
                      <Tag key={t.role} kind={t.winner ? undefined : "live"}>
                        {t.name}: {t.winner?.name ?? (t.roundId ? `round #${t.roundId}` : "…")}
                      </Tag>
                    ))}
                  </div>
                  <Status value={c.status === "done" ? "delivered" : c.status === "failed" ? "failed" : "Open"} />
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="stack" style={{ gap: 16 }}>
          <span className="label">Your transactions</span>
          <div className="card flush">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Your agent</th>
                    <th>Side</th>
                    <th>Counterparty</th>
                    <th>Service</th>
                    <th className="r">Amount</th>
                    <th>Epoch</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {(activity?.jobs ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <Empty>No jobs yet.</Empty>
                      </td>
                    </tr>
                  ) : (
                    activity!.jobs.map((j) => {
                      const bought = ids.has(j.buyer);
                      return (
                        <tr key={j.id}>
                          <td className="faint">{ago(j.createdAt)}</td>
                          <td>
                            <AgentChip id={bought ? j.buyer : j.seller} agents={live.agents} />
                          </td>
                          <td>{bought ? "bought" : "sold"}</td>
                          <td>
                            <AgentChip id={bought ? j.seller : j.buyer} agents={live.agents} />
                          </td>
                          <td>
                            <Link className="link" to={`/jobs/${j.id}`}>
                              {j.service}
                            </Link>
                          </td>
                          <td className="r num">{usd(j.price, 4)}</td>
                          <td>
                            <Link to={`/epochs/${j.epoch}`}>#{j.epoch}</Link>
                          </td>
                          <td>
                            <Status value={j.status} />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card flush">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Epoch</th>
                    <th>Debtor</th>
                    <th className="r">Net debt paid</th>
                    <th>State</th>
                    <th>Settled in</th>
                  </tr>
                </thead>
                <tbody>
                  {(activity?.settlements ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <Empty>No settlement yet. When an epoch closes with your agent owing money, it signs NEAR Intents transfers for exactly that and the batch settles on chain.</Empty>
                      </td>
                    </tr>
                  ) : (
                    activity!.settlements.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link to={`/epochs/${s.epoch}`}>#{s.epoch}</Link>
                        </td>
                        <td>{agentName(live.agents, s.agentId)}</td>
                        <td className="r num">{usd(s.amount, 4)}</td>
                        <td>
                          <Status value={s.status} />
                        </td>
                        <td>
                          <Tx hash={s.settleTx} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="stack" style={{ gap: 16 }}>
          <span className="label">Spending limits you signed</span>
          <div className="card flush">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>For</th>
                    <th className="r">Budget</th>
                    <th className="r">Spent</th>
                    <th className="r">Per job</th>
                    <th>Until</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {(me?.intents ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <Empty>None signed yet.</Empty>
                      </td>
                    </tr>
                  ) : (
                    me!.intents.map((i) => (
                      <tr key={i.id}>
                        <td>{agentName(live.agents, i.buyer)}</td>
                        <td className="r num">{usd(i.budget, 3)}</td>
                        <td className="r num">{usd(i.spent, 4)}</td>
                        <td className="r num">{usd(i.perJobCap, 3)}</td>
                        <td className="faint">{new Date(i.deadline * 1000).toLocaleDateString()}</td>
                        <td>
                          <Status value={i.status} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Profile({ me, onSaved }: { me: Me | null; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (me) setName(me.user.displayName ?? "");
  }, [me?.user.displayName]);
  if (!me) return null;
  const save = async () => {
    setSaving(true);
    try {
      await authed("api", "/v1/me", { method: "PATCH", body: JSON.stringify({ displayName: name }) });
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="card spread" style={{ gap: 18, flexWrap: "wrap" }}>
      <div className="stack" style={{ gap: 4 }}>
        <span className="label">Profile</span>
        <span className="muted">
          Member since {new Date(me.user.createdAt).toLocaleDateString()} · {me.user.logins} sign-in{me.user.logins === 1 ? "" : "s"}
        </span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <input aria-label="Display name" placeholder="Display name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} style={{ width: 220 }} />
        <button className="btn sm" disabled={saving || name === (me.user.displayName ?? "")} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

function Launch({ count, onLaunched }: { count: number; onLaunched: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (count >= 3) return null;
  const launch = async () => {
    setBusy(true);
    setMsg({ ok: true, text: "Creating the agent's NEAR account, registering it with you as operator and funding it… about half a minute on testnet." });
    try {
      const r = await authed<{ account: string; agentId: string }>("fleet", "/users/me/agents", { method: "POST", body: JSON.stringify({ name: name || "My agent" }) });
      setMsg({ ok: true, text: `Agent #${r.agentId} is live as ${r.account}. Next: sign its spending limit.` });
      setName("");
      onLaunched();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <span className="label">Launch an agent</span>
      <p className="muted" style={{ margin: 0 }}>
        A hosted agent: its own sub-account of the deployment, registered on chain with your account as its operator, with 2 test USDC of collateral and 2 inside the NEAR Intents verifier. Up to three per account.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input aria-label="Agent name" placeholder="Name, e.g. Scout for Chai Point" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} style={{ flex: "1 1 240px" }} />
        <button className="btn" disabled={busy} onClick={() => void launch()}>
          {busy ? "Launching…" : "Launch agent"}
        </button>
      </div>
      {msg && <p style={{ margin: 0, color: msg.ok ? "var(--muted)" : "var(--bad)" }}>{msg.text}</p>}
    </div>
  );
}

function AgentCard({ a, hosted, intents, onChange }: { a: AgentSummary; hosted?: Hosted; intents: IntentView[]; onChange: () => void }) {
  const acc = useAccount();
  const now = Date.now() / 1000;
  const active = intents.find((i) => i.status === "active" && i.deadline > now);
  const [budget, setBudget] = useState(1);
  const [studio, setStudio] = useState<(typeof STUDIOS)[number]["kind"]>("design");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = STUDIOS.find((x) => x.kind === studio)!;

  const authorise = async () => {
    setMsg(null);
    const r = await authoriseSpending(a.agentId, budget, 0.05, 7);
    if (r) {
      setMsg({ ok: true, text: `Signed: ${a.name} may spend up to ${budget} USDC, at most 0.05 a job, for a week.` });
      onChange();
    }
  };
  const commission = async () => {
    if (!hosted) return;
    setBusy(true);
    setMsg(null);
    try {
      const brief = text.trim() ? { [s.field]: text.trim(), ...s.extra } : null;
      const r = await authed<{ message: string }>("fleet", `/users/me/agents/${hosted.slug}/hire`, { method: "POST", body: JSON.stringify({ studio, brief }) });
      setMsg({ ok: true, text: r.message });
      setText("");
      onChange();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack" style={{ gap: 14 }}>
      <div className="spread">
        <AgentChip id={a.agentId} agents={[a]} />
        <Status value={a.status} />
      </div>
      <dl className="kv" style={{ gridTemplateColumns: "auto 1fr" }}>
        <dt>Account</dt>
        <dd>
          <Account id={a.account} />
        </dd>
        <dt>Operator</dt>
        <dd className="mono">{a.operator}</dd>
        <dt>Collateral free</dt>
        <dd className="num">{usd(a.collateral.available, 3)}</dd>
        <dt>Reputation</dt>
        <dd className="num">{a.reputation}</dd>
        <dt>Spending limit</dt>
        <dd>{active ? `${usd(active.spent, 4)} of ${usd(active.budget, 2)} used` : <span className="faint">none signed</span>}</dd>
      </dl>
      {!active ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="muted" htmlFor={`b-${a.agentId}`}>
              Budget (USDC)
            </label>
            <input id={`b-${a.agentId}`} type="number" min={0.05} max={2} step={0.05} value={budget} onChange={(e) => setBudget(Math.min(2, Math.max(0.05, Number(e.target.value) || 0.05)))} style={{ width: 90 }} />
            <button className="btn sm" disabled={!!acc.busy} onClick={() => void authorise()}>
              Sign spending limit
            </button>
          </div>
          <small className="faint">Your wallet signs an intent: this budget, 0.05 USDC per job at most, valid for 7 days. Nothing is spent until the agent buys.</small>
        </div>
      ) : hosted ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select aria-label="Studio" value={studio} onChange={(e) => setStudio(e.target.value as typeof studio)}>
              {STUDIOS.map((x) => (
                <option key={x.kind} value={x.kind}>
                  {x.name}
                </option>
              ))}
            </select>
            <input aria-label="Brief" placeholder={s.placeholder} value={text} maxLength={60} onChange={(e) => setText(e.target.value)} style={{ flex: "1 1 180px" }} />
          </div>
          <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void commission()}>
            {busy ? "Hiring…" : "Commission the studio"}
          </button>
        </div>
      ) : (
        <small className="faint">This agent is not hosted here, so it acts on its own; you can still see its jobs below.</small>
      )}
      {acc.busy && <small className="muted">{acc.busy}</small>}
      {acc.error && <small style={{ color: "var(--bad)" }}>{acc.error}</small>}
      {msg && <small style={{ color: msg.ok ? "var(--muted)" : "var(--bad)" }}>{msg.text}</small>}
      <Link className="link" to={`/agents/${a.agentId}`}>
        Agent page
      </Link>
    </div>
  );
}
