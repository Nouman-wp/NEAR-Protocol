import type {
  AgentSummary,
  Deployment,
  DisputeView,
  EpochView,
  HeadlineStats,
  Hex,
  IntentView,
  JobView,
  QuorumDomain,
  RoundView,
  SettlementOrder,
  SettlementView,
  SignedIntent,
  VerifierKind,
} from "@quorum/core";

export interface ClearingConfig {
  network: { key: string; name: string; explorer: string | null; rpc: string };
  deployment: Deployment;
  domain: QuorumDomain;
  epochs: { intakeSeconds: number; challengeSeconds: number; disputeWindowSeconds: number; arbitrationTimeoutSeconds: number; settlementWindowSeconds: number };
  intents: { account: string; kind: VerifierKind; token: string; note: string };
  clearer: string;
}

export type SubmitResult =
  | { ok: true; jobId: string; iouDigest: Hex; epoch: number; disputeWindowSeconds: number }
  | { ok: false; reason: string; currentEpoch?: number };

export class QuorumApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const query = (q: object): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.size ? `?${p.toString()}` : "";
};

/** Thin typed client for the clearing service REST API. */
export class ClearingClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new QuorumApiError((json as { error?: string })?.error ?? `HTTP ${res.status}`, res.status);
    return json as T;
  }

  config = () => this.req<ClearingConfig>("GET", "/v1/config");
  stats = () => this.req<HeadlineStats>("GET", "/v1/stats");
  agents = (q: { capability?: string; maxPrice?: string; minReputation?: number; q?: string } = {}) => this.req<AgentSummary[]>("GET", `/v1/agents${query(q)}`);
  agent = (id: string) => this.req<{ agent: AgentSummary }>("GET", `/v1/agents/${id}`);
  nonce = (agentId: string) => this.req<{ nonce: string; epoch: number; intakeEndsAt: number }>("GET", `/v1/agents/${agentId}/nonce`);
  submitIou = (body: unknown) => this.req<SubmitResult>("POST", "/v1/ious", body);
  job = (id: string) => this.req<{ job: JobView; iou: { digest: Hex; status: string } | null; dispute: DisputeView | null }>("GET", `/v1/jobs/${id}`);
  deliver = (body: unknown) => this.req<{ ok: boolean; challengeEndsAt?: number }>("POST", "/v1/deliveries", body);
  fileDispute = (body: unknown) => this.req<DisputeView>("POST", "/v1/disputes", body);
  disputes = (q: { status?: string; validator?: string } = {}) => this.req<(DisputeView & { job: JobView })[]>("GET", `/v1/disputes${query(q)}`);
  dispute = (id: string) => this.req<{ dispute: DisputeView; job: JobView; spec: unknown; quote: unknown; result: unknown }>("GET", `/v1/disputes/${id}`);
  verdict = (id: string, body: unknown) => this.req<DisputeView>("POST", `/v1/disputes/${id}/verdict`, body);
  createIntent = (body: unknown) => this.req<IntentView>("POST", "/v1/intents", body);
  intents = (q: { operator?: string; buyer?: string }) => this.req<IntentView[]>("GET", `/v1/intents${query(q)}`);
  revokeIntent = (id: string, body: unknown) => this.req<IntentView>("POST", `/v1/intents/${id}/revoke`, body);
  settlements = (q: { agentId?: string; status?: string; epoch?: number }) => this.req<(SettlementView & { order: SettlementOrder })[]>("GET", `/v1/settlements${query(q)}`);
  /** Hand in the signed NEAR Intents payload that pays one debt. */
  submitIntent = (id: string, signed: SignedIntent) => this.req<SettlementView>("POST", `/v1/settlements/${id}/intent`, { signed });
  epochs = (limit = 20) => this.req<EpochView[]>("GET", `/v1/epochs?limit=${limit}`);
  epoch = (id: number) => this.req<{ epoch: EpochView }>("GET", `/v1/epochs/${id}`);

  rounds = (q: { status?: string; kind?: string; agent?: string; limit?: number } = {}) => this.req<RoundView[]>("GET", `/v1/rounds${query(q)}`);
  round = (id: number) => this.req<{ round: RoundView; jobs: JobView[] }>("GET", `/v1/rounds/${id}`);
  /** Publish the job specification behind a round's on-chain spec_hash. */
  describeRound = (id: number, spec: unknown, title?: string) => this.req<RoundView>("POST", `/v1/rounds/${id}/spec`, { spec, title });
  noteRoundTx = (id: number, kind: "open" | "close", hash: string, sender: string) => this.req<{ ok: boolean }>("POST", `/v1/rounds/${id}/tx`, { kind, hash, sender });
  refreshRound = (id: number) => this.req<RoundView>("POST", `/v1/rounds/${id}/refresh`, {});
  roundPrices = (service: string) => this.req<{ round: number; at: number; price: string; reserve: string; quantity: number; bids: number; kind: string }[]>("GET", `/v1/rounds/prices${query({ service })}`);
}
