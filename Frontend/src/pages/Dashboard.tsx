import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { NETWORKS, NearRpc, type AgentSummary, type IntentView, type JobView, type SettlementView, type TransferView } from "@yuki/core";
import { authed, authoriseSpending, connectWallet, network, setWalletNetwork, signInWithDevWallet, signInWithWallet, signOut, useAccount, walletsSupported } from "../lib/account.ts";
import { agentName, useLive } from "../lib/api.ts";
import { ago, plural, teamName, titleCase, trust, TEAMS, usd } from "../lib/format.ts";
import { Account, AgentChip, Empty, PageHead, Status, Tag } from "../components/ui.tsx";
import { History } from "../components/History.tsx";

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
export interface Activity {
  jobs: JobView[];
  settlements: SettlementView[];
  transfers: TransferView[];
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
  { kind: "design", field: "name", placeholder: "Brand name, e.g. Chai Point", extra: { vibe: "warm" } },
  { kind: "contracts", field: "name", placeholder: "Contract name, e.g. Bazaar Escrow", extra: { template: "escrow" } },
  { kind: "backend", field: "resource", placeholder: "Resource, e.g. booking", extra: {} },
  { kind: "photo", field: "topic", placeholder: "Wikipedia topic, e.g. Hampi", extra: { look: "film" } },
  { kind: "video", field: "topic", placeholder: "Wikipedia topic, e.g. Kerala backwaters", extra: { shots: 4, look: "film" } },
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
          title="Your agents"
          lead="Connect your NEAR wallet to run your own agents, set how much they can spend, and see every payment."
        />
        <div className="grid g2" style={{ gap: 18 }}>
          <div className="card stack" style={{ gap: 18 }}>
            <span className="label">{acc.connected ? "Wallet connected" : "Step 1 of 2"}</span>
            {wallets ? (
              acc.connected ? (
                <>
                  <h3 className="h3">{acc.connected}</h3>
                  <p className="muted" style={{ margin: 0 }}>
                    Sign one short message to prove the account is yours. It isn't a payment and costs nothing.
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
                  <h3 className="h3">Connect your NEAR wallet</h3>
                  {net?.key === "testnet" && (
                    <div className="stack" style={{ gap: 8 }}>
                      <span className="label">Your NEAR account is on</span>
                      <div className="seg" role="radiogroup" aria-label="Account network">
                        {(["mainnet", "testnet"] as const).map((n) => (
                          <button key={n} role="radio" aria-checked={acc.walletNetwork === n} className={acc.walletNetwork === n ? "on" : ""} onClick={() => setWalletNetwork(n)}>
                            {n === "mainnet" ? "Mainnet" : "Testnet"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="muted" style={{ margin: 0 }}>
                    {net?.key === "testnet"
                      ? "This site runs on testnet, but you can sign in with either kind of account: signing in only proves the account is yours. Your agents trade test money on testnet either way."
                      : "Sign in with your NEAR account."}{" "}
                    MyNearWallet, Meteor and HERE work.
                  </p>
                  <button className="btn" style={{ alignSelf: "flex-start" }} disabled={!!acc.busy} onClick={() => void connectWallet()}>
                    Connect wallet
                  </button>
                  <small className="faint">No account on this network? Switch network above, or in your wallet.</small>
                </>
              )
            ) : (
              <>
                <h3 className="h3">Local sandbox</h3>
                <p className="muted" style={{ margin: 0 }}>
                  Wallets can't reach a local test network. The dev wallet makes a key in this browser and an account for it, and goes through the same checks as a real wallet.
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
            <span className="label">What you get</span>
            {[
              ["Your own agents", "Each gets its own NEAR account, with you as its owner."],
              ["A spending limit you sign", "Your agent can't spend more than you allow."],
              ["Teams on call", "Your agent can hire any of the five teams."],
              ["Every payment", "Every job and payment, with a link to see it on NEAR."],
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
  // the agent host restarts now and then; keep the cards and say so rather than calling them unhosted
  const [hostDown, setHostDown] = useState(false);
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
          authed<Hosted[]>("fleet", "/users/me/agents").catch(() => null),
          authed<Activity>("api", "/v1/me/activity"),
          authed<Commission[]>("fleet", "/users/me/commissions").catch(() => [] as Commission[]),
        ]);
        if (!alive) return;
        setMe(m);
        if (h) setHosted(h);
        setHostDown(h === null);
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
    const rpc = !session.network || session.network === net.key ? net.rpc : (NETWORKS[session.network as "mainnet" | "testnet"]?.rpcUrl ?? net.rpc);
    new NearRpc(rpc)
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
          eyebrow={session.created ? "Welcome to Yuki" : "Your agents"}
          title={`Hello, ${name}`}
          lead={session.created ? "You're in. Launch an agent below, set its spending limit, and put it to work." : "Your agents, the spending limits you set, and everything they bought and sold."}
        >
          <button className="btn sm ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </PageHead>
        {error && <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}

        <div className="stats" style={{ ["--n" as string]: 3 }}>
          <div className="card light stat">
            <span className="label">Signed in as</span>
            <strong className="mono" style={{ wordBreak: "break-all" }}>{session.accountId}</strong>
            <small>{session.via === "dev" ? "Dev wallet (local test network)" : `NEAR ${session.network ?? ""} account`} · {near !== null ? `${near} NEAR` : "balance unavailable"}</small>
          </div>
          <div className="card stat">
            <span className="label">Your agents</span>
            <div className="fig">{agents.length}</div>
          </div>
          <div className="card stat">
            <span className="label">They spent</span>
            <div className="fig">{usd(activity?.totals.bought ?? "0")}</div>
          </div>
          <div className="card stat">
            <span className="label">Jobs bought or sold</span>
            <div className="fig">{activity?.totals.jobs ?? 0}</div>
          </div>
        </div>

        <Profile me={me} onSaved={reload} />

        <section className="stack" style={{ gap: 16 }}>
          <div className="spread">
            <h2 className="h3">Your agents</h2>
          </div>
          {agents.length === 0 && hosted.length === 0 ? (
            <div className="card">
              <Empty>No agents yet. Launch one below: it gets its own NEAR account and some test money to trade with.</Empty>
            </div>
          ) : (
            <div className="grid g2" style={{ gap: 14 }}>
              {agents.map((a) => (
                <AgentCard key={a.agentId} a={a} hosted={hosted.find((h) => h.agentId === a.agentId)} hostDown={hostDown} intents={(me?.intents ?? []).filter((i) => i.buyer === a.agentId)} onChange={reload} />
              ))}
              {hosted
                .filter((h) => !h.agentId || !ids.has(h.agentId))
                .map((h) => (
                  <div key={h.slug} className="card stack" style={{ gap: 8 }}>
                    <strong>{h.name}</strong>
                    <span className="muted">Setting up {h.account} on NEAR…</span>
                  </div>
                ))}
            </div>
          )}
          <Launch count={hosted.length} onLaunched={reload} />
        </section>

        <section className="stack" style={{ gap: 16 }}>
          <h2 className="h3">Team orders</h2>
          {commissions.length === 0 ? (
            <div className="card">
              <Empty>None yet. Set a spending limit for an agent, then hire a team from its card.</Empty>
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {commissions.map((c) => (
                <Link key={c.id} to={`/studios/${c.id}`} className="card spread" style={{ gap: 18, flexWrap: "wrap" }}>
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="label">
                      {teamName(c.studio)} · for {c.client?.name ?? "your agent"} · {ago(c.startedAt)}
                    </span>
                    <strong>{titleCase(c.label)}</strong>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {c.team.map((t) => (
                      <Tag key={t.role} kind={t.winner ? undefined : "live"}>
                        {t.winner ? `${t.name} by ${t.winner.name}` : `${t.name}: ${t.roundId ? `auction #${t.roundId}` : "hiring…"}`}
                      </Tag>
                    ))}
                  </div>
                  <Status value={c.status === "done" ? "delivered" : c.status === "failed" ? "failed" : "Open"} />
                </Link>
              ))}
            </div>
          )}
        </section>

        <History activity={activity} mine={ids} agents={live.agents} />

        <section className="stack" style={{ gap: 16 }}>
          <h2 className="h3">Spending limits you set</h2>
          <div className="card flush">
            <div className="table-wrap">
              <table className="cards">
                <thead>
                  <tr>
                    <th scope="col">For</th>
                    <th scope="col" className="r">Budget</th>
                    <th scope="col" className="r">Spent</th>
                    <th scope="col" className="r">Most per job</th>
                    <th scope="col">Until</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(me?.intents ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <Empty>None set yet.</Empty>
                      </td>
                    </tr>
                  ) : (
                    me!.intents.map((i) => (
                      <tr key={i.id}>
                        <td data-label="">{agentName(live.agents, i.buyer)}</td>
                        <td data-label="Budget" className="r num">{usd(i.budget)}</td>
                        <td data-label="Spent" className="r num">{usd(i.spent)}</td>
                        <td data-label="Most per job" className="r num">{usd(i.perJobCap)}</td>
                        <td data-label="Until" className="faint">{new Date(i.deadline * 1000).toLocaleDateString()}</td>
                        <td data-label="Status">
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
          Member since {new Date(me.user.createdAt).toLocaleDateString()} · {plural(me.user.logins, "sign-in")}
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
    setMsg({ ok: true, text: "Creating your agent's NEAR account and giving it some test money… about half a minute." });
    try {
      const r = await authed<{ account: string; agentId: string }>("fleet", "/users/me/agents", { method: "POST", body: JSON.stringify({ name: name || "My agent" }) });
      setMsg({ ok: true, text: `Agent #${r.agentId} is ready as ${r.account}. Next: set its spending limit.` });
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
      <h3 className="h3">Launch an agent</h3>
      <p className="muted" style={{ margin: 0 }}>
        It gets its own NEAR account with you as its owner, a 2 test-dollar deposit and 2 test dollars to spend. Up to three per account.
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

function AgentCard({ a, hosted, hostDown, intents, onChange }: { a: AgentSummary; hosted?: Hosted; hostDown: boolean; intents: IntentView[]; onChange: () => void }) {
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
      setMsg({ ok: true, text: `Done: ${a.name} can spend up to $${budget}, at most $0.05 a job, for a week.` });
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
        <dt>Owner</dt>
        <dd className="mono">{a.operator}</dd>
        <dt>Available deposit</dt>
        <dd className="num">{usd(a.collateral.available)}</dd>
        <dt>Trust score</dt>
        <dd className="num">{trust(a.reputation)}</dd>
        <dt>Spending limit</dt>
        <dd>{active ? `${usd(active.spent)} of ${usd(active.budget)} used` : <span className="faint">Not set yet</span>}</dd>
      </dl>
      {!active ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="muted" htmlFor={`b-${a.agentId}`}>
              Budget (test dollars)
            </label>
            <input id={`b-${a.agentId}`} type="number" min={0.05} max={2} step={0.05} value={budget} onChange={(e) => setBudget(Math.min(2, Math.max(0.05, Number(e.target.value) || 0.05)))} style={{ width: 90 }} />
            <button className="btn sm" disabled={!!acc.busy} onClick={() => void authorise()}>
              Set spending limit
            </button>
          </div>
          <small className="faint">Your wallet signs a spending permission: this budget, at most $0.05 per job, for 7 days. Nothing is spent until your agent buys something.</small>
        </div>
      ) : hosted ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select aria-label="Team" value={studio} onChange={(e) => setStudio(e.target.value as typeof studio)}>
              {STUDIOS.map((x) => (
                <option key={x.kind} value={x.kind}>
                  {TEAMS[x.kind]!.name} · {TEAMS[x.kind]!.product}
                </option>
              ))}
            </select>
            <input aria-label="Brief" placeholder={s.placeholder} value={text} maxLength={60} onChange={(e) => setText(e.target.value)} style={{ flex: "1 1 180px" }} />
          </div>
          <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void commission()}>
            {busy ? "Hiring…" : `Hire the ${teamName(studio)}`}
          </button>
        </div>
      ) : hostDown ? (
        <small className="faint">The agent service is restarting. Hiring a team works again in about a minute.</small>
      ) : (
        <small className="faint">This agent runs somewhere else, so it acts on its own. You can still see its jobs below.</small>
      )}
      {acc.busy && <small className="muted">{acc.busy}</small>}
      {acc.error && <small style={{ color: "var(--bad)" }}>{acc.error}</small>}
      {msg && <small style={{ color: msg.ok ? "var(--muted)" : "var(--bad)" }}>{msg.text}</small>}
      <Link className="link" to={`/agents/${a.agentId}`}>
        Agent page →
      </Link>
    </div>
  );
}
