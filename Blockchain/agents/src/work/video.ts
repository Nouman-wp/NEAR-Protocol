import gifenc from "gifenc";
import { wikiSearch } from "./wikipedia.ts";
import { sentences } from "./text.ts";
import { GRADES, grade, loadSource, wikiPhoto, type Grade, type Img } from "./image.ts";

/**
 * Video work: a storyboard built from a Wikipedia topic (shots, camera moves and captions
 * from the article text, photos from the articles' lead images), a cut rendered frame by
 * frame into an animated GIF (Ken Burns moves and crossfades over the real photos), and
 * WebVTT captions timed to the cut. The GIF is real video work at a small size; there is
 * no video encoder on the server, so the format is GIF.
 */

export const MOVES = ["push-in", "pan-right", "pull-out", "pan-left"] as const;
export type Move = (typeof MOVES)[number];

export interface Shot {
  n: number;
  image: string | null;
  source: string | null;
  move: Move;
  seconds: number;
  caption: string;
}

export interface Storyboard {
  title: string;
  topic: string;
  look: Grade;
  fps: number;
  width: number;
  height: number;
  titleSeconds: number;
  crossfadeSeconds: number;
  shots: Shot[];
  totalSeconds: number;
}

export interface VideoBrief {
  topic: string;
  title?: string;
  shots?: number;
  look?: Grade;
}

const shorten = (s: string, max = 84) => {
  const clean = s.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : max).replace(/[,;:]$/, "")}…`;
};

export async function storyboard(brief: VideoBrief): Promise<Storyboard> {
  const topic = brief.topic.trim().slice(0, 100) || "Monsoon";
  const want = Math.min(6, Math.max(3, Math.round(brief.shots ?? 4)));
  const look = brief.look && (GRADES as readonly string[]).includes(brief.look) ? brief.look : "film";
  const search = await wikiSearch(topic, "en", 6);
  const lines = sentences(search.hits.map((h) => h.extract ?? h.snippet).join(" "))
    .filter((s) => s.length > 30)
    .slice(0, want);
  // photos: the topic's own lead image first, then those of related articles
  const titles = [topic, ...search.hits.map((h) => h.title)];
  const photos: { url: string; title: string }[] = [];
  for (const t of titles) {
    if (photos.length >= want) break;
    const p = await wikiPhoto(t).catch(() => null);
    if (p && !photos.some((x) => x.url === p.url)) photos.push(p);
  }
  const shots: Shot[] = Array.from({ length: want }, (_, i) => ({
    n: i + 1,
    image: photos[i]?.url ?? null,
    source: photos[i]?.title ?? null,
    move: MOVES[i % MOVES.length]!,
    seconds: 2,
    caption: shorten(lines[i] ?? `${topic}, scene ${i + 1}.`),
  }));
  const titleSeconds = 1;
  return {
    title: (brief.title ?? topic).slice(0, 60),
    topic,
    look,
    fps: 6,
    width: 240,
    height: 135,
    titleSeconds,
    crossfadeSeconds: 0.5,
    shots,
    totalSeconds: titleSeconds + shots.reduce((a, s) => a + s.seconds, 0),
  };
}

// ------------------------------------------------------------------ the cut

/** One frame of a Ken Burns move over `src` at progress t (0..1), sampled bilinearly. */
export function kenBurns(src: Img, move: Move, t: number, w: number, h: number): Img {
  const aspect = w / h;
  let bw = src.width;
  let bh = bw / aspect;
  if (bh > src.height) {
    bh = src.height;
    bw = bh * aspect;
  }
  const zoom = move === "push-in" ? 1 + 0.18 * t : move === "pull-out" ? 1.18 - 0.18 * t : 1.12;
  const vw = bw / zoom;
  const vh = bh / zoom;
  let cx = src.width / 2;
  const cy = src.height / 2;
  if (move === "pan-right") cx = vw / 2 + (src.width - vw) * t;
  if (move === "pan-left") cx = src.width - vw / 2 - (src.width - vw) * t;
  const x0 = Math.min(src.width - vw, Math.max(0, cx - vw / 2));
  const y0 = Math.min(src.height - vh, Math.max(0, cy - vh / 2));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fy = y0 + (y / (h - 1)) * (vh - 1);
    const yA = Math.floor(fy);
    const yB = Math.min(src.height - 1, yA + 1);
    const ty = fy - yA;
    for (let x = 0; x < w; x++) {
      const fx = x0 + (x / (w - 1)) * (vw - 1);
      const xA = Math.floor(fx);
      const xB = Math.min(src.width - 1, xA + 1);
      const tx = fx - xA;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = src.data[(yA * src.width + xA) * 4 + c]!;
        const b = src.data[(yA * src.width + xB) * 4 + c]!;
        const cc = src.data[(yB * src.width + xA) * 4 + c]!;
        const d = src.data[(yB * src.width + xB) * 4 + c]!;
        out[o + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function blend(a: Img, b: Img, t: number): Img {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i]! * (1 - t) + b.data[i]! * t;
  return { width: a.width, height: a.height, data: out };
}

/** The title card: the look's colours sweeping across, with the first photo fading in. */
function titleCard(first: Img, t: number): Img {
  const { width: w, height: h } = first;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const band = x / w < t * 1.4 - 0.2 ? 1 : 0;
      const k = Math.max(0, t - 0.5) * 2;
      const base = [42 + band * 70, 18 + band * 22, 26 + band * 30];
      for (let c = 0; c < 3; c++) out[o + c] = base[c]! * (1 - k) + first.data[o + c]! * k;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export interface Cut {
  frames: number;
  seconds: number;
  width: number;
  height: number;
  gif: Uint8Array;
  sources: { shot: number; url: string | null; synthetic: boolean }[];
}

export async function renderCut(board: Storyboard, load: typeof loadSource = loadSource): Promise<Cut> {
  const { width: w, height: h, fps } = board;
  const sources = await Promise.all(board.shots.map((s, i) => load(s.image ? { imageUrl: s.image } : {}, i + 1)));
  const graded = sources.map((s) => grade(s.img, board.look));
  const frames: Img[] = [];
  const first = kenBurns(graded[0]!, board.shots[0]!.move, 0, w, h);
  const titleFrames = Math.round(board.titleSeconds * fps);
  for (let f = 0; f < titleFrames; f++) frames.push(titleCard(first, f / Math.max(1, titleFrames - 1)));
  const fade = Math.round(board.crossfadeSeconds * fps);
  board.shots.forEach((shot, i) => {
    const n = Math.round(shot.seconds * fps);
    const next = board.shots[i + 1];
    for (let f = 0; f < n; f++) {
      const t = f / Math.max(1, n - 1);
      let frame = kenBurns(graded[i]!, shot.move, t, w, h);
      if (next && f >= n - fade) frame = blend(frame, kenBurns(graded[i + 1]!, next.move, 0, w, h), (f - (n - fade) + 1) / (fade + 1));
      frames.push(frame);
    }
  });
  // one palette for the whole cut, from a sample of frames, so colours do not flicker
  const sample = frames.filter((_, i) => i % 4 === 0);
  const pool = new Uint8Array(sample.length * w * h * 4);
  sample.forEach((f, i) => pool.set(f.data, i * w * h * 4));
  const palette = gifenc.quantize(pool, 128, { format: "rgb565" });
  const enc = gifenc.GIFEncoder();
  for (const f of frames) enc.writeFrame(gifenc.applyPalette(f.data, palette, "rgb565"), w, h, { palette, delay: Math.round(1000 / fps) });
  enc.finish();
  return {
    frames: frames.length,
    seconds: Math.round((frames.length / fps) * 10) / 10,
    width: w,
    height: h,
    gif: enc.bytes(),
    sources: sources.map((s, i) => ({ shot: i + 1, url: s.url, synthetic: s.synthetic })),
  };
}

// ------------------------------------------------------------------ captions

const ts = (s: number) => {
  const ms = Math.round(s * 1000);
  const hh = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const mm = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const ss = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
  return `${hh}:${mm}:${ss}.${String(ms % 1000).padStart(3, "0")}`;
};

/** Wrap to at most two lines of 42 characters, the usual broadcast limit. */
export function wrap(text: string, width = 42): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [""];
  for (const word of words) {
    const cur = lines[lines.length - 1]!;
    if ((cur ? `${cur} ${word}` : word).length <= width) lines[lines.length - 1] = cur ? `${cur} ${word}` : word;
    else if (lines.length < 2) lines.push(word);
    else {
      lines[1] = `${lines[1]!.slice(0, width - 1).replace(/\s+\S*$/, "")}…`;
      break;
    }
  }
  return lines.filter(Boolean);
}

export interface Captions {
  vtt: string;
  cues: { start: number; end: number; lines: string[] }[];
  checks: { name: string; ok: boolean }[];
}

export function captions(board: Storyboard): Captions {
  const cues: Captions["cues"] = [{ start: 0, end: board.titleSeconds, lines: wrap(board.title) }];
  let t = board.titleSeconds;
  for (const s of board.shots) {
    cues.push({ start: t + 0.1, end: t + s.seconds - 0.15, lines: wrap(s.caption) });
    t += s.seconds;
  }
  const vtt = ["WEBVTT", "", ...cues.flatMap((c, i) => [`${i + 1}`, `${ts(c.start)} --> ${ts(c.end)}`, ...c.lines, ""])].join("\n");
  const checks = [
    { name: "cues are in order and never overlap", ok: cues.every((c, i) => c.end > c.start && (i === 0 || c.start >= cues[i - 1]!.end)) },
    { name: "every cue is on screen for at least a second", ok: cues.every((c) => c.end - c.start >= 1) },
    { name: "at most two lines of 42 characters", ok: cues.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= 42)) },
    { name: "the captions end with the cut", ok: Math.abs(t - board.totalSeconds) < 0.01 },
  ];
  return { vtt, cues, checks };
}
