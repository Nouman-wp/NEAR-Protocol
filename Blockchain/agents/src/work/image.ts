import jpeg from "jpeg-js";

/**
 * Photo work on real pixels: decode a JPEG, retouch it (auto levels, a contrast curve,
 * sharpening), colour-grade it, and reframe it for social formats around its most
 * detailed region. Photos come from Wikipedia articles (the lead image) or any
 * Wikimedia image URL. If none can be fetched, a generated test scene is used and
 * the result says so.
 */

export interface Img {
  width: number;
  height: number;
  /** RGBA, row-major */
  data: Uint8Array;
}

export interface Stats {
  meanLuma: number;
  contrast: number;
  clippedPct: number;
}

export interface Source {
  img: Img;
  url: string | null;
  title: string | null;
  license: string;
  synthetic: boolean;
}

const UA = "Quorum/0.1 (NEAR hackathon agent swarm; https://github.com/Nouman-wp/NEAR-Protocol)";
const MAX_BYTES = 4_000_000;
const WIKIMEDIA_HOSTS = ["upload.wikimedia.org", "thumb.wikimedia.org"];

export const GRADES = ["film", "noir", "teal-orange", "vintage", "vivid"] as const;
export type Grade = (typeof GRADES)[number];

export const FORMATS = {
  square: { w: 480, h: 480 },
  story: { w: 360, h: 640 },
  banner: { w: 640, h: 214 },
} as const;
export type Format = keyof typeof FORMATS;

// ------------------------------------------------------------------ in / out

export function decodeJpeg(bytes: Uint8Array): Img {
  const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 12, maxMemoryUsageInMB: 256 });
  return { width: d.width, height: d.height, data: d.data };
}

export function encodeJpeg(img: Img, quality = 84): Uint8Array {
  return new Uint8Array(jpeg.encode({ data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height }, quality).data);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !WIKIMEDIA_HOSTS.includes(u.hostname)) throw new Error("photos are fetched from Wikimedia only");
  const res = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  if (!/jpeg/.test(res.headers.get("content-type") ?? "")) throw new Error("not a JPEG");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("image too large");
  return buf;
}

/** The lead image of a Wikipedia article, about 640 px wide, if it is a JPEG. */
export async function wikiPhoto(topic: string): Promise<{ url: string; title: string } | null> {
  const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.trim().replace(/ /g, "_"))}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const s = (await res.json()) as { title?: string; thumbnail?: { source: string; width: number }; originalimage?: { source: string; width: number } };
  const thumb = s.thumbnail?.source;
  if (!thumb || !/\.jpe?g/i.test(thumb)) return null;
  // Wikimedia serves thumbnails at standard widths only (330, 500, 960, ...)
  const original = s.originalimage?.width ?? 0;
  const u = new URL(original >= 960 ? thumb.replace(/\/\d+px-/, "/960px-") : original >= 500 ? thumb.replace(/\/\d+px-/, "/500px-") : thumb);
  u.search = "";
  return { url: u.toString(), title: s.title ?? topic };
}

export async function loadSource(input: { topic?: string; imageUrl?: string }, seed = 1): Promise<Source> {
  try {
    let url = input.imageUrl ?? null;
    let title: string | null = null;
    if (!url && input.topic) {
      const w = await wikiPhoto(input.topic);
      if (w) ({ url, title } = w);
    }
    if (url) {
      const img = downscale(decodeJpeg(await fetchBytes(url)), 720);
      return { img, url, title, license: "Wikimedia Commons (see the file page for its licence)", synthetic: false };
    }
  } catch {
    // fall through to the generated scene
  }
  return { img: syntheticScene(480, 320, seed), url: null, title: input.topic ?? null, license: "generated test scene", synthetic: true };
}

/** A procedurally generated landscape: sky, sun and three ridges. */
export function syntheticScene(width: number, height: number, seed: number): Img {
  const data = new Uint8Array(width * height * 4);
  const r = (n: number) => Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453 % 1;
  const ridge = (x: number, k: number) => height * (0.45 + k * 0.13) + Math.sin(x / (40 + k * 25) + seed + k) * (18 - k * 3) + Math.sin(x / 13 + k * 7) * 4;
  const sunX = width * (0.25 + Math.abs(r(1)) * 0.5);
  const sunY = height * 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const t = y / height;
      let [cr, cg, cb] = [240 - t * 90, 170 - t * 40, 120 + t * 70];
      const d = Math.hypot(x - sunX, y - sunY);
      if (d < 26) [cr, cg, cb] = [255, 236, 190];
      else if (d < 60) [cr, cg, cb] = [cr + (60 - d) * 0.8, cg + (60 - d) * 0.5, cb];
      for (let k = 0; k < 3; k++) {
        if (y > ridge(x, k)) [cr, cg, cb] = [70 - k * 20 + k * 6, 60 + k * 12, 80 - k * 18];
      }
      const n = (Math.abs(r(x * 0.37 + y * 1.13)) - 0.5) * 10;
      data[i] = clamp(cr + n);
      data[i + 1] = clamp(cg + n);
      data[i + 2] = clamp(cb + n);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

// ------------------------------------------------------------------ measuring

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const lumaAt = (d: Uint8Array, i: number) => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;

export function stats(img: Img): Stats {
  const n = img.width * img.height;
  let sum = 0;
  let sq = 0;
  let clipped = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const l = lumaAt(img.data, i);
    sum += l;
    sq += l * l;
    if (l < 3 || l > 252) clipped++;
  }
  const mean = sum / n;
  return { meanLuma: Math.round(mean * 10) / 10, contrast: Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean)) * 10) / 10, clippedPct: Math.round((clipped / n) * 1000) / 10 };
}

// ------------------------------------------------------------------ retouch

function mapPixels(img: Img, f: (r: number, g: number, b: number, x: number, y: number) => [number, number, number]): Img {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const [r, g, b] = f(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, x, y);
      out[i] = clamp(r);
      out[i + 1] = clamp(g);
      out[i + 2] = clamp(b);
      out[i + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/** Stretch each channel so its 0.5th and 99.5th percentiles become black and white. */
export function autoLevels(img: Img): Img {
  const lut: Uint8Array[] = [];
  const n = img.width * img.height;
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < img.data.length; i += 4) hist[img.data[i]!]!++;
    let lo = 0;
    let hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]!) < n * 0.005; lo++);
    for (let acc = 0; hi > 0 && (acc += hist[hi]!) < n * 0.005; hi--);
    const span = Math.max(1, hi - lo);
    lut[c] = Uint8Array.from({ length: 256 }, (_, v) => clamp(((v - lo) / span) * 255));
  }
  return mapPixels(img, (r, g, b) => [lut[0]![r]!, lut[1]![g]!, lut[2]![b]!]);
}

/** A gentle S-curve: deeper shadows, brighter highlights. */
export function contrastCurve(img: Img, strength = 0.35): Img {
  const lut = Uint8Array.from({ length: 256 }, (_, v) => {
    const x = v / 255;
    const s = x * x * (3 - 2 * x);
    return clamp((x + strength * (s - x)) * 255);
  });
  return mapPixels(img, (r, g, b) => [lut[r]!, lut[g]!, lut[b]!]);
}

/** Unsharp mask with a 3x3 kernel, blended in at `amount`. */
export function sharpen(img: Img, amount = 0.5): Img {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8Array(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          out[i + c] = d[i + c]!;
          continue;
        }
        const v = 5 * d[i + c]! - d[i - 4 + c]! - d[i + 4 + c]! - d[i - w * 4 + c]! - d[i + w * 4 + c]!;
        out[i + c] = clamp(d[i + c]! + (v - d[i + c]!) * amount);
      }
      out[i + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export function retouch(img: Img): Img {
  return sharpen(contrastCurve(autoLevels(img), 0.3), 0.4);
}

// ------------------------------------------------------------------ grade

export function grade(img: Img, look: Grade): Img {
  const cx = img.width / 2;
  const cy = img.height / 2;
  const maxD = Math.hypot(cx, cy);
  const vignette = (x: number, y: number, k: number) => 1 - k * (Math.hypot(x - cx, y - cy) / maxD) ** 2;
  switch (look) {
    case "film":
      return mapPixels(img, (r, g, b, x, y) => {
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const v = vignette(x, y, 0.25);
        // lifted blacks, warm highlights, slightly muted colour
        const mix = (c: number) => 14 + c * 0.92;
        const m = (0.2126 * r + 0.7152 * g + 0.0722 * b) * 0.15;
        return [(mix(r * 0.85 + m) + l * 10) * v, mix(g * 0.85 + m) * v, (mix(b * 0.85 + m) - l * 8) * v];
      });
    case "noir":
      return contrastCurve(
        mapPixels(img, (r, g, b, x, y) => {
          const l = (0.3 * r + 0.59 * g + 0.11 * b) * vignette(x, y, 0.35);
          return [l, l, l];
        }),
        0.55,
      );
    case "teal-orange":
      return mapPixels(img, (r, g, b) => {
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const sh = 1 - l;
        return [r + 22 * l - 18 * sh, g + 6 * l + 4 * sh, b - 20 * l + 22 * sh];
      });
    case "vintage":
      return mapPixels(img, (r, g, b, x, y) => {
        const v = vignette(x, y, 0.4);
        return [(0.393 * r + 0.769 * g + 0.189 * b) * 0.9 * v + 12, (0.349 * r + 0.686 * g + 0.168 * b) * 0.9 * v + 8, (0.272 * r + 0.534 * g + 0.131 * b) * 0.9 * v + 4];
      });
    case "vivid":
      return mapPixels(img, (r, g, b) => {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return [l + (r - l) * 1.35, l + (g - l) * 1.35, l + (b - l) * 1.35];
      });
  }
}

// ------------------------------------------------------------------ reframe

/** The centre of detail: the gradient-weighted centroid, so crops keep the subject. */
export function detailCentre(img: Img): { x: number; y: number } {
  const { width: w, height: h, data: d } = img;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = (y * w + x) * 4;
      const gx = lumaAt(d, i + 4) - lumaAt(d, i - 4);
      const gy = lumaAt(d, i + w * 4) - lumaAt(d, i - w * 4);
      const g = Math.abs(gx) + Math.abs(gy);
      sx += x * g;
      sy += y * g;
      sw += g;
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : { x: w / 2, y: h / 2 };
}

export function crop(img: Img, x0: number, y0: number, cw: number, ch: number): Img {
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + cw) * 4), y * cw * 4);
  return { width: cw, height: ch, data: out };
}

/** Bilinear resize. */
export function resize(img: Img, w: number, h: number): Img {
  const out = new Uint8Array(w * h * 4);
  const xr = (img.width - 1) / Math.max(1, w - 1);
  const yr = (img.height - 1) / Math.max(1, h - 1);
  for (let y = 0; y < h; y++) {
    const fy = y * yr;
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x * xr;
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c]!;
        const b = img.data[(y0 * img.width + x1) * 4 + c]!;
        const cc = img.data[(y1 * img.width + x0) * 4 + c]!;
        const dd = img.data[(y1 * img.width + x1) * 4 + c]!;
        out[o + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty);
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export function downscale(img: Img, maxSide: number): Img {
  const k = maxSide / Math.max(img.width, img.height);
  return k >= 1 ? img : resize(img, Math.round(img.width * k), Math.round(img.height * k));
}

/** The largest window of the format's shape centred on the detail, resized to the format. */
export function reframe(img: Img, format: Format): Img & { window: { x: number; y: number; w: number; h: number } } {
  const t = FORMATS[format];
  const aspect = t.w / t.h;
  let cw = img.width;
  let ch = Math.round(cw / aspect);
  if (ch > img.height) {
    ch = img.height;
    cw = Math.round(ch * aspect);
  }
  const c = detailCentre(img);
  const x = Math.round(Math.min(img.width - cw, Math.max(0, c.x - cw / 2)));
  const y = Math.round(Math.min(img.height - ch, Math.max(0, c.y - ch / 2)));
  // never upscale: a small source gives a smaller file of the same shape
  const outW = Math.min(t.w, cw);
  const outH = Math.round(outW / aspect);
  return { ...resize(crop(img, x, y, cw, ch), outW, outH), window: { x, y, w: cw, h: ch } };
}
