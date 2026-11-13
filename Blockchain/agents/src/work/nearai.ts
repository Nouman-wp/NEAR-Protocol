/**
 * NEAR AI Cloud: OpenAI-compatible chat completions served by NEAR AI's private inference
 * (open models running inside TEEs; each answer can be checked against the enclave's
 * signature). Optional: set NEAR_AI_API_KEY (from cloud.near.ai) to switch it on. Without a
 * key, or when a call fails or times out, the agents that use it fall back to their
 * rule-based work, so a commission never fails because of the model.
 */

export interface AiStatus {
  provider: "NEAR AI Cloud";
  enabled: boolean;
  model: string;
  endpoint: string;
}

export interface AiAnswer {
  text: string;
  model: string;
  /** the completion id; the enclave's signature for it is at `/v1/signature/{chatId}` */
  chatId: string | null;
  ms: number;
  /** the enclave's signature over this exchange, when NEAR AI returns one */
  signature: { signingAddress: string | null; signature: string; algo: string } | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const env = (k: string) => (process.env[k] ?? "").trim();

/** A verifiable (TEE-hosted) open model by default; NEAR_AI_MODEL picks another from the catalogue. */
export const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

export function aiStatus(): AiStatus {
  return {
    provider: "NEAR AI Cloud",
    enabled: env("NEAR_AI_API_KEY") !== "",
    model: env("NEAR_AI_MODEL") || DEFAULT_MODEL,
    endpoint: (env("NEAR_AI_URL") || "https://cloud-api.near.ai/v1").replace(/\/+$/, ""),
  };
}

/** Strip a reasoning preamble and code fences, leaving the answer itself. */
export function cleanAnswer(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:json|text)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/** The first JSON object in a model's answer, or null. */
export function parseJsonAnswer<T>(raw: string): T | null {
  const text = cleanAnswer(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`NEAR AI answered ${res.status}: ${body.slice(0, 160)}`);
    return JSON.parse(body);
  } finally {
    clearTimeout(t);
  }
}

/**
 * One chat completion. Throws when NEAR AI is not configured or the call fails; callers
 * catch that and use their fallback.
 */
export async function chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<AiAnswer> {
  const s = aiStatus();
  if (!s.enabled) throw new Error("NEAR AI is not configured (NEAR_AI_API_KEY is empty)");
  const key = env("NEAR_AI_API_KEY");
  const timeout = opts.timeoutMs ?? Number(env("NEAR_AI_TIMEOUT_SECONDS") || 25) * 1000;
  const started = Date.now();
  const r = (await fetchJson(
    `${s.endpoint}/chat/completions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: s.model, messages, max_tokens: opts.maxTokens ?? 700, temperature: opts.temperature ?? 0.7, stream: false }),
    },
    timeout,
  )) as { id?: string; model?: string; choices?: { message?: { content?: string | { text?: string }[] } }[] };
  const content = r.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : "";
  if (!text.trim()) throw new Error("NEAR AI returned an empty answer");
  const answer: AiAnswer = { text, model: r.model ?? s.model, chatId: r.id ?? null, ms: Date.now() - started, signature: null };
  // the enclave signs each exchange; keep its signature with the work when NEAR AI offers one
  if (answer.chatId) {
    const sig = (await fetchJson(
      `${s.endpoint}/signature/${encodeURIComponent(answer.chatId)}?model=${encodeURIComponent(s.model)}&signing_algo=ecdsa`,
      { headers: { authorization: `Bearer ${key}` } },
      5_000,
    ).catch(() => null)) as { signature?: string; signing_address?: string; signing_algo?: string } | null;
    if (sig?.signature) answer.signature = { signature: sig.signature, signingAddress: sig.signing_address ?? null, algo: sig.signing_algo ?? "ecdsa" };
  }
  return answer;
}
