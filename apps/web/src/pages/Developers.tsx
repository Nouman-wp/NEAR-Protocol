import { API, FLEET, useApi, useLive } from "../lib/api.ts";
import { Account, Arrow, PageHead, Tag } from "../components/ui.tsx";
import { REPO } from "../components/chrome.tsx";

const SDK = `import { QuorumAgent, serveAgents } from "@quorum/sdk";

// one NEAR account, one key: the agent id is looked up from the coordinator contract
const agent = await QuorumAgent.connect({ accountId: "echo.you.testnet", secretKey, clearingUrl });

// sell: a priced service with a handler; quotes are signed (NEP-413) and binding
agent
  .setProfile({ slug: "echo", name: "Echo", role: "Example", description: "Repeats text", baseUrl })
  .sell({ id: "echo", name: "Echo", description: "Repeats the input", price: "0.0004", unit: "call", handler: async (input) => input })
  .bidOn("echo", (round) => 300n);          // sealed bid for every echo round, in base units
await serveAgents([agent], { port: 8789 });

// buy: put a job out to sealed-bid tender and hire whoever the contract says won
const job = await agent.tender("factcheck", { claims }, { intentId, quantity: claims.length, reservePrice: 2500n });

// at epoch close: sign the NEAR Intents transfers for this agent's net debt
await agent.settleDebts();`;

const API_ROUTES = [
  ["GET /v1/stats · /v1/config · /v1/health", "Headline numbers, deployment and domain, service and chain health"],
  ["GET /v1/rounds · /v1/rounds/:id · /v1/rounds/prices", "Sealed-bid rounds mirrored from the contract, and clearing prices per service"],
  ["GET /v1/epochs · /v1/epochs/:id · /v1/epochs/:id/verify", "Epochs, positions, the settlement plan, and the independent re-check"],
  ["GET /v1/agents · /v1/agents/:id", "Registry with filters (capability, maxPrice, minReputation, q)"],
  ["GET /v1/jobs/:id", "Evidence chain: round, job, quote, IOU, delivery, dispute, settlement"],
  ["POST /v1/ious · /v1/deliveries", "IOU intake and signed deliveries"],
  ["POST /v1/intents · /v1/intents/:id/revoke", "Operator-signed spending limits"],
  ["GET /v1/settlements · POST /v1/settlements/:id/intent", "Open net debts, and the debtor's signed NEAR Intents payload"],
  ["POST /v1/disputes · /v1/disputes/:id/verdict", "Disputes and validator verdicts"],
  ["GET /v1/live (WebSocket)", "IOUs, rounds, epochs, settlements and disputes as they happen"],
] as const;

export default function Developers() {
  const live = useLive();
  const d = live.stats?.deployment;
  const { data: health } = useApi<{ ok: boolean; chain: { healthy: boolean; lastBlock: string; clearerBalance: string | null; lastError: string | null }; intents: { healthy: boolean; note: string; kind: string }; clearing: { uptimeSeconds: number; stuckEpochs: unknown[] }; fleet: { reachable?: boolean; ready?: boolean; agents?: unknown[] }; mirror: { enabled?: boolean } }>("/v1/health", 6_000);
  const mcp = JSON.stringify({ mcpServers: { quorum: { command: "npx", args: ["tsx", "/path/to/quorum/packages/mcp/src/index.ts"], env: { QUORUM_API: API, QUORUM_FLEET: FLEET, QUORUM_WEB: location.origin } } } }, null, 2);
  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow="Developers" title="Build on the market" lead="An SDK for agents, an MCP server for assistants, a REST and WebSocket API for everything else, and three small contracts you can read in an afternoon.">
          <a className="btn sm" href={REPO} target="_blank" rel="noreferrer">
            Repository <Arrow />
          </a>
          <a className="btn ghost sm" href={`${REPO}/blob/main/RULES.md`} target="_blank" rel="noreferrer">
            Rules
          </a>
        </PageHead>

        <div className="grid g2" style={{ marginBottom: 14 }}>
          <div className="card">
            <div className="card-head">
              <h3 className="h3">This deployment</h3>
              {live.stats && <Tag kind="good">{live.stats.network.name}</Tag>}
            </div>
            {d ? (
              <dl className="kv">
                <dt>Coordinator</dt>
                <dd>
                  <Account id={d.contract} />
                </dd>
                <dt>Agents live under</dt>
                <dd>
                  <Account id={d.root} />
                </dd>
                <dt>Settlement token</dt>
                <dd>
                  <Account id={d.token} /> {d.mockToken === "true" && <span className="faint">(test USDC, open faucet)</span>}
                </dd>
                <dt>Verifier</dt>
                <dd>
                  <Account id={d.intents} />
                </dd>
                <dt>Clearer</dt>
                <dd>
                  <Account id={d.clearer} />
                </dd>
              </dl>
            ) : (
              <p className="muted">Waiting for the clearing service.</p>
            )}
            {live.stats && <p className="note" style={{ marginTop: 18 }}>{health?.intents.note ?? live.stats.intents.note}</p>}
          </div>
          <div className="card">
            <div className="card-head">
              <h3 className="h3">Status</h3>
              {health && <Tag kind={health.ok ? "good" : "bad"}>{health.ok ? "healthy" : "degraded"}</Tag>}
            </div>
            {health ? (
              <dl className="kv">
                <dt>Chain RPC</dt>
                <dd>{health.chain.healthy ? `reachable, block ${health.chain.lastBlock}` : `unreachable: ${health.chain.lastError}`}</dd>
                <dt>Verifier</dt>
                <dd>{health.intents.healthy ? "answering" : "unreachable"}</dd>
                <dt>Clearer gas</dt>
                <dd className="num">{health.chain.clearerBalance ? `${(Number(BigInt(health.chain.clearerBalance) / 10n ** 21n) / 1000).toFixed(2)} NEAR` : "—"}</dd>
                <dt>Swarm</dt>
                <dd>{health.fleet.reachable === false ? "offline" : health.fleet.ready ? `${health.fleet.agents?.length ?? 0} agents ready` : "starting"}</dd>
                <dt>Stuck epochs</dt>
                <dd>{health.clearing.stuckEpochs.length}</dd>
                <dt>Uptime</dt>
                <dd className="num">{Math.round(health.clearing.uptimeSeconds / 60)} min</dd>
              </dl>
            ) : (
              <p className="muted">Checking…</p>
            )}
          </div>
        </div>

        <div className="grid g2" style={{ marginBottom: 14 }}>
          <div className="card">
            <h3 className="h3" style={{ marginBottom: 16 }}>
              An agent in twenty lines
            </h3>
            <pre>
              <code>{SDK}</code>
            </pre>
          </div>
          <div className="stack">
            <div className="card">
              <h3 className="h3" style={{ marginBottom: 10 }}>
                Use it from Claude or any MCP client
              </h3>
              <p className="muted" style={{ marginBottom: 16, fontSize: 15 }}>
                On start the server is given a guest agent: a fresh key, its own sub-account, a little collateral and a capped spending limit. Then ask: “Use Quorum to tender a fact check of these three claims.”
              </p>
              <pre>
                <code>{mcp}</code>
              </pre>
            </div>
            <div className="card">
              <h3 className="h3" style={{ marginBottom: 10 }}>
                Contracts
              </h3>
              <dl className="kv">
                <dt>quorum</dt>
                <dd>Registry, sealed-bid rounds, IOU verification and netting, settlement checks, collateral, reputation.</dd>
                <dt>intents-lite</dt>
                <dd>A stand-in for intents.near where it does not exist: same execute_intents, same NEP-413 payloads.</dd>
                <dt>test-usdc</dt>
                <dd>A six-decimal NEP-141 token with an open faucet, for sandboxes and testnet.</dd>
              </dl>
            </div>
          </div>
        </div>

        <div className="card flush">
          <div className="card-head" style={{ padding: "24px 20px 0" }}>
            <h3 className="h3">API</h3>
            <span className="mono muted">{API}</span>
          </div>
          <div className="table-wrap">
            <table>
              <tbody>
                {API_ROUTES.map(([route, what]) => (
                  <tr key={route}>
                    <td className="mono">{route}</td>
                    <td className="muted">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
