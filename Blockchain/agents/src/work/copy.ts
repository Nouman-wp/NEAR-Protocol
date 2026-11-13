import { createHash } from "node:crypto";
import { aiStatus, chat, parseJsonAnswer, type AiAnswer } from "./nearai.ts";
import { vibeOf, type DesignBrief, type Vibe } from "./design.ts";

/**
 * Brand copy for the Design Team's brand kit: a tagline, a short brand story, three voice
 * traits and three headlines. The AI copywriter writes it with a NEAR AI Cloud model; the
 * template writer below is its fallback (and the whole job for a copywriter without a
 * model), so the brand kit always ships with copy.
 */

export interface BrandCopy {
  tagline: string;
  story: string;
  voice: string[];
  headlines: string[];
  engine: { kind: "near-ai"; model: string; chatId: string | null; ms: number; signature: AiAnswer["signature"] } | { kind: "template"; reason: string };
}

const VOICE: Record<Vibe, string[]> = {
  warm: ["friendly", "unhurried", "generous"],
  cool: ["precise", "calm", "confident"],
  earthy: ["honest", "grounded", "neighbourly"],
  neon: ["bold", "playful", "fast"],
  pastel: ["gentle", "light", "optimistic"],
  mono: ["minimal", "direct", "assured"],
};

const TAGLINES: Record<Vibe, string[]> = {
  warm: ["Made with care, served with a smile", "A little warmth in every day", "Slow down, you're among friends"],
  cool: ["Clear thinking, cleanly done", "Built to stay cool under pressure", "Less noise, more signal"],
  earthy: ["Grown close, made honest", "Rooted in the good stuff", "From the ground up"],
  neon: ["Turn it up", "Loud ideas, bright results", "Plug in and play"],
  pastel: ["Softly, brightly, every day", "Small joys, made easy", "Light on its feet"],
  mono: ["Only what matters", "Simple, on purpose", "Nothing extra"],
};

const pick = <T>(list: T[], seed: string, salt: string) => list[createHash("sha256").update(`${seed}:${salt}`).digest().readUInt32BE(0) % list.length]!;

/** Deterministic copy from the name and vibe: the same brief always gets the same words. */
export function templateCopy(brief: DesignBrief, reason: string): BrandCopy {
  const vibe = vibeOf(brief);
  const name = brief.name.trim() || "Untitled";
  const voice = VOICE[vibe];
  const tagline = brief.tagline?.trim() || pick(TAGLINES[vibe], name, "tagline");
  return {
    tagline,
    story: `${name} is for people who want things done well and without fuss. Everything we make is ${voice[0]}, ${voice[1]} and ${voice[2]}, and it shows from the first hello to the last detail. ${tagline}.`,
    voice,
    headlines: [`Meet ${name}`, `${name}: ${tagline.toLowerCase()}`, `Why people come back to ${name}`],
    engine: { kind: "template", reason },
  };
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Copy from NEAR AI when it is configured and answers well; the template writer otherwise. */
export async function writeCopy(brief: DesignBrief, opts: { useModel: boolean }): Promise<BrandCopy> {
  if (!opts.useModel) return templateCopy(brief, "written by a template copywriter");
  if (!aiStatus().keySet) return templateCopy(brief, "NEAR AI is not configured on this deployment (no NEAR_AI_API_KEY), so the template writer wrote it");
  const vibe = vibeOf(brief);
  try {
    const answer = await chat(
      [
        {
          role: "system",
          content:
            "You are a brand copywriter. Answer with one JSON object only, no prose: " +
            '{"tagline": string (max 60 chars), "story": string (2-3 sentences, max 320 chars), "voice": [3 single-word traits], "headlines": [3 headlines, max 60 chars each]}. ' +
            "Plain words, no emoji, no hashtags, no quotation marks inside the strings.",
        },
        { role: "user", content: `Brand name: ${clip(brief.name, 40)}\nVibe: ${vibe}${brief.tagline ? `\nKeep this tagline: ${clip(brief.tagline, 80)}` : ""}` },
      ],
      { maxTokens: 600, temperature: 0.8 },
    );
    const j = parseJsonAnswer<{ tagline?: unknown; story?: unknown; voice?: unknown; headlines?: unknown }>(answer.text);
    const voice = Array.isArray(j?.voice) ? j!.voice.map((v) => clip(v, 24)).filter(Boolean).slice(0, 3) : [];
    const headlines = Array.isArray(j?.headlines) ? j!.headlines.map((h) => clip(h, 70)).filter(Boolean).slice(0, 3) : [];
    const tagline = brief.tagline?.trim() || clip(j?.tagline, 70);
    const story = clip(j?.story, 400);
    if (!tagline || !story || voice.length < 3 || headlines.length < 3) return templateCopy(brief, "the model's answer was incomplete, so the template writer wrote it");
    return { tagline, story, voice, headlines, engine: { kind: "near-ai", model: answer.model, chatId: answer.chatId, ms: answer.ms, signature: answer.signature } };
  } catch (err) {
    return templateCopy(brief, `NEAR AI did not answer (${(err as Error).message.slice(0, 120)}), so the template writer wrote it`);
  }
}
