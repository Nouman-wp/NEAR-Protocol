import { afterEach, describe, expect, it, vi } from "vitest";
import { aiStatus, chat, cleanAnswer, DEFAULT_MODEL, parseJsonAnswer } from "../src/work/nearai.ts";
import { templateCopy, writeCopy } from "../src/work/copy.ts";
import { FREELANCERS } from "../src/agents/studios.ts";

const KEY = "NEAR_AI_API_KEY";

afterEach(() => {
  delete process.env[KEY];
  vi.unstubAllGlobals();
});

/** A NEAR AI Cloud stand-in: one chat completion, then the enclave's signature for it. */
function fakeNearAi(content: string) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url.includes("/signature/")
      ? { text: "req:res", signature: "0xabc", signing_address: "0x1234", signing_algo: "ecdsa" }
      : { id: "chatcmpl-1", model: DEFAULT_MODEL, choices: [{ message: { role: "assistant", content } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

describe("NEAR AI client", () => {
  it("is off without a key, and says which model it would use", () => {
    expect(aiStatus()).toMatchObject({ provider: "NEAR AI Cloud", enabled: false, model: DEFAULT_MODEL, endpoint: "https://cloud-api.near.ai/v1" });
  });

  it("refuses to call out without a key, so callers fall back", async () => {
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow(/not configured/);
  });

  it("sends an OpenAI-style request with the key and keeps the enclave's signature", async () => {
    process.env[KEY] = "test-key";
    const calls = fakeNearAi("hello");
    const a = await chat([{ role: "user", content: "hi" }]);
    expect(a).toMatchObject({ text: "hello", chatId: "chatcmpl-1", signature: { signature: "0xabc", signingAddress: "0x1234" } });
    expect(calls[0]!.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ model: DEFAULT_MODEL, messages: [{ role: "user", content: "hi" }] });
    expect(calls[1]!.url).toContain("/signature/chatcmpl-1");
  });

  it("strips reasoning and code fences, and finds the JSON in an answer", () => {
    expect(cleanAnswer("<think>hmm</think>\n```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(parseJsonAnswer<{ a: number }>("Sure! {\"a\": 2} hope that helps")).toEqual({ a: 2 });
    expect(parseJsonAnswer("no json here")).toBeNull();
  });
});

describe("brand copy", () => {
  const brief = { name: "Chai Point", vibe: "warm" as const };

  it("the template writer is deterministic and complete", () => {
    const a = templateCopy(brief, "test");
    expect(a).toEqual(templateCopy(brief, "test"));
    expect(a.voice).toHaveLength(3);
    expect(a.headlines).toHaveLength(3);
    expect(a.story).toContain("Chai Point");
    expect(a.engine).toEqual({ kind: "template", reason: "test" });
    expect(templateCopy({ ...brief, tagline: "Tea, properly" }, "x").tagline).toBe("Tea, properly");
  });

  it("uses NEAR AI's copy when the model answers well", async () => {
    process.env[KEY] = "test-key";
    fakeNearAi(JSON.stringify({ tagline: "Tea that feels like home", story: "Chai Point brews chai the slow way. Every cup is made to order.", voice: ["warm", "kind", "local"], headlines: ["Chai, done right", "Your daily cup", "Brewed slow"] }));
    const c = await writeCopy(brief, { useModel: true });
    expect(c.tagline).toBe("Tea that feels like home");
    expect(c.engine).toMatchObject({ kind: "near-ai", model: DEFAULT_MODEL, chatId: "chatcmpl-1" });
  });

  it("falls back to the template writer when the model is off, fails or answers badly", async () => {
    expect((await writeCopy(brief, { useModel: true })).engine.kind).toBe("template");
    process.env[KEY] = "test-key";
    fakeNearAi("I cannot help with that.");
    const bad = await writeCopy(brief, { useModel: true });
    expect(bad.engine).toMatchObject({ kind: "template" });
    vi.stubGlobal("fetch", async () => new Response("overloaded", { status: 503 }));
    const down = await writeCopy(brief, { useModel: true });
    expect(down.engine.kind).toBe("template");
    expect((down.engine as { reason: string }).reason).toMatch(/503/);
  });

  it("one copywriter uses NEAR AI and another writes from templates, so the role is contested", () => {
    const writers = FREELANCERS.filter((f) => f.skills.copy);
    expect(writers.map((f) => f.slug).sort()).toEqual(["kern", "quill"]);
    expect(writers.filter((f) => f.ai).map((f) => f.slug)).toEqual(["quill"]);
  });
});
