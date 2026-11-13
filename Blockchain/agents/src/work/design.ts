import { createHash } from "node:crypto";

/**
 * Design work, done by code: a colour palette that meets WCAG contrast, a modular type
 * scale with a font pairing, a geometric logo mark, and a one-page brand sheet. All of it
 * follows from the brief (name and vibe), so the same brief gives the same brand.
 */

export const VIBES = ["warm", "cool", "earthy", "neon", "pastel", "mono"] as const;
export type Vibe = (typeof VIBES)[number];

export interface DesignBrief {
  name: string;
  vibe?: Vibe;
  tagline?: string;
}

export interface Swatch {
  role: "primary" | "secondary" | "accent" | "ink" | "paper";
  hex: string;
}

export interface Palette {
  vibe: Vibe;
  swatches: Swatch[];
  /** WCAG 2.1 contrast of the pairs the brand will actually use */
  pairs: { fg: string; bg: string; use: string; ratio: number; aa: boolean }[];
}

export interface TypeScale {
  display: string;
  text: string;
  ratio: number;
  base: number;
  steps: { name: string; px: number; rem: number; lineHeight: number; tracking: string }[];
  css: string;
}

export function vibeOf(brief: DesignBrief): Vibe {
  if (brief.vibe && (VIBES as readonly string[]).includes(brief.vibe)) return brief.vibe;
  return VIBES[seedOf(brief.name) % VIBES.length]!;
}

function seedOf(s: string): number {
  return createHash("sha256").update(s.trim().toLowerCase()).digest().readUInt32BE(0);
}

// ------------------------------------------------------------------ colour maths

export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

const VIBE_SHAPE: Record<Vibe, { hues: [number, number]; sat: number; light: number; offset: number }> = {
  warm: { hues: [0, 45], sat: 72, light: 46, offset: 32 },
  cool: { hues: [185, 250], sat: 62, light: 44, offset: -38 },
  earthy: { hues: [20, 110], sat: 36, light: 40, offset: 48 },
  neon: { hues: [0, 360], sat: 96, light: 50, offset: 150 },
  pastel: { hues: [0, 360], sat: 58, light: 62, offset: 120 },
  mono: { hues: [0, 360], sat: 9, light: 42, offset: 0 },
};

// ------------------------------------------------------------------ palette

export function makePalette(brief: DesignBrief): Palette {
  const vibe = vibeOf(brief);
  const shape = VIBE_SHAPE[vibe];
  const seed = seedOf(`${brief.name}|${vibe}`);
  const [lo, hi] = shape.hues;
  const hue = lo + (seed % 1000) / 1000 * (hi - lo);
  const paper = hslToHex(hue, Math.min(shape.sat, 30), 96);
  const ink = hslToHex(hue, Math.min(shape.sat, 25), 11);
  // darken the primary until white text on it, and it on paper, both pass AA (4.5:1)
  let light = shape.light;
  let primary = hslToHex(hue, shape.sat, light);
  while ((contrast(primary, "#ffffff") < 4.5 || contrast(primary, paper) < 4.5) && light > 8) primary = hslToHex(hue, shape.sat, (light -= 2));
  const secondary = hslToHex(hue + 180 + shape.offset / 3, Math.max(12, shape.sat - 18), Math.min(80, shape.light + 22));
  let accentLight = Math.min(70, shape.light + 12);
  let accent = hslToHex(hue + shape.offset, Math.min(100, shape.sat + 10), accentLight);
  // the accent sits on ink (dark mode buttons, highlights): keep it at 3:1 at least
  while (contrast(accent, ink) < 3 && accentLight < 92) accent = hslToHex(hue + shape.offset, Math.min(100, shape.sat + 10), (accentLight += 3));
  const swatches: Swatch[] = [
    { role: "primary", hex: primary },
    { role: "secondary", hex: secondary },
    { role: "accent", hex: accent },
    { role: "ink", hex: ink },
    { role: "paper", hex: paper },
  ];
  const pair = (fg: string, bg: string, use: string, min = 4.5) => {
    const ratio = contrast(fg, bg);
    return { fg, bg, use, ratio, aa: ratio >= min };
  };
  return {
    vibe,
    swatches,
    pairs: [pair(ink, paper, "body text on paper"), pair("#ffffff", primary, "white text on primary buttons"), pair(primary, paper, "links and headings on paper"), pair(accent, ink, "accent on dark surfaces", 3)],
  };
}

// ------------------------------------------------------------------ type

const PAIRINGS: Record<Vibe, { display: string; text: string; ratio: number }> = {
  warm: { display: "Fraunces", text: "Inter", ratio: 1.25 },
  cool: { display: "Space Grotesk", text: "IBM Plex Sans", ratio: 1.2 },
  earthy: { display: "DM Serif Display", text: "Source Sans 3", ratio: 1.25 },
  neon: { display: "Syne", text: "Manrope", ratio: 1.333 },
  pastel: { display: "Quicksand", text: "Nunito", ratio: 1.2 },
  mono: { display: "IBM Plex Mono", text: "IBM Plex Sans", ratio: 1.2 },
};

const STEP_NAMES = ["caption", "body", "lead", "h4", "h3", "h2", "h1", "display"];

export function makeTypeScale(brief: DesignBrief): TypeScale {
  const vibe = vibeOf(brief);
  const p = PAIRINGS[vibe];
  const base = 16;
  const steps = STEP_NAMES.map((name, i) => {
    const k = i - 1;
    const px = Math.round(base * p.ratio ** k * 100) / 100;
    const lineHeight = Math.round(Math.max(1.05, 1.6 - Math.max(0, k) * 0.08) * 100) / 100;
    const tracking = k >= 4 ? "-0.02em" : k === -1 ? "0.01em" : "0";
    return { name, px, rem: Math.round((px / base) * 1000) / 1000, lineHeight, tracking };
  });
  const css = [
    ":root {",
    `  --font-display: "${p.display}", Georgia, serif;`,
    `  --font-text: "${p.text}", system-ui, sans-serif;`,
    ...steps.map((s) => `  --step-${s.name}: ${s.rem}rem; /* ${s.px}px, line-height ${s.lineHeight} */`),
    "}",
  ].join("\n");
  return { display: p.display, text: p.text, ratio: p.ratio, base, steps, css };
}

// ------------------------------------------------------------------ logo

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A geometric mark from the name's hash, in the palette's colours, plus the wordmark. */
export function makeLogo(brief: DesignBrief, palette: Palette): { svg: string; motif: string } {
  const seed = seedOf(brief.name);
  const c = Object.fromEntries(palette.swatches.map((s) => [s.role, s.hex])) as Record<Swatch["role"], string>;
  const motifs = ["rings", "petals", "blocks", "orbit", "facets"] as const;
  const motif = motifs[seed % motifs.length]!;
  const n = 5 + (seed % 4);
  const parts: string[] = [];
  const cx = 120;
  const cy = 104;
  switch (motif) {
    case "rings":
      for (let i = 0; i < 4; i++) parts.push(`<circle cx="${cx + (i - 1.5) * 9}" cy="${cy}" r="${58 - i * 12}" fill="none" stroke="${i % 2 ? c.accent : c.primary}" stroke-width="7"/>`);
      break;
    case "petals":
      for (let i = 0; i < n; i++) parts.push(`<ellipse cx="${cx}" cy="${cy - 34}" rx="16" ry="38" fill="${i % 2 ? c.primary : c.accent}" opacity="0.88" transform="rotate(${(360 / n) * i} ${cx} ${cy})"/>`);
      break;
    case "blocks":
      for (let i = 0; i < 9; i++) {
        if ((seed >> i) & 1 || i === 4) parts.push(`<rect x="${cx - 54 + (i % 3) * 38}" y="${cy - 54 + Math.floor(i / 3) * 38}" width="32" height="32" rx="7" fill="${i === 4 ? c.accent : c.primary}"/>`);
      }
      break;
    case "orbit":
      parts.push(`<circle cx="${cx}" cy="${cy}" r="22" fill="${c.primary}"/>`);
      for (let i = 0; i < 3; i++) parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="62" ry="22" fill="none" stroke="${i === 1 ? c.accent : c.primary}" stroke-width="4" transform="rotate(${i * 60} ${cx} ${cy})"/>`);
      break;
    case "facets": {
      const pts = Array.from({ length: n }, (_, i) => {
        const a = ((Math.PI * 2) / n) * i - Math.PI / 2;
        return [cx + Math.cos(a) * 62, cy + Math.sin(a) * 62] as const;
      });
      pts.forEach(([x, y], i) => {
        const [x2, y2] = pts[(i + 1) % n]!;
        parts.push(`<polygon points="${cx},${cy} ${x.toFixed(1)},${y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="${i % 2 ? c.primary : c.accent}" opacity="${0.75 + (i % 3) * 0.1}"/>`);
      });
      break;
    }
  }
  const initial = esc((brief.name.trim()[0] ?? "Q").toUpperCase());
  const word = esc(brief.name.trim().slice(0, 28));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">`,
    `<rect width="240" height="240" rx="28" fill="${c.paper}"/>`,
    ...parts,
    `<text x="${cx}" y="${cy + 11}" text-anchor="middle" font-family="Georgia, serif" font-size="30" font-weight="700" fill="${c.paper}">${initial}</text>`,
    `<text x="120" y="212" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${word.length > 16 ? 15 : 20}" font-weight="600" letter-spacing="0.5" fill="${c.ink}">${word}</text>`,
    `</svg>`,
  ].join("");
  return { svg, motif };
}

/** The studio's finished one-pager: logo, palette with contrast checks, and the type specimen. */
export function makeBrandSheet(brief: DesignBrief, palette: Palette, type: TypeScale, logoSvg: string): string {
  const c = Object.fromEntries(palette.swatches.map((s) => [s.role, s.hex])) as Record<Swatch["role"], string>;
  const inner = logoSvg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const swatches = palette.swatches
    .map((s, i) => {
      const x = 330 + i * 122;
      const text = contrast(s.hex, "#ffffff") >= 4.5 ? "#ffffff" : c.ink;
      return `<rect x="${x}" y="70" width="110" height="150" rx="14" fill="${s.hex}" stroke="${c.ink}" stroke-opacity="0.12"/><text x="${x + 12}" y="194" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="${text}">${s.role}</text><text x="${x + 12}" y="210" font-family="ui-monospace, monospace" font-size="12" fill="${text}">${s.hex}</text>`;
    })
    .join("");
  const checks = palette.pairs
    .map((p, i) => `<text x="330" y="${262 + i * 20}" font-family="system-ui, sans-serif" font-size="13" fill="${c.ink}">${p.aa ? "✓" : "✗"} ${esc(p.use)}: ${p.ratio}:1</text>`)
    .join("");
  const specimen = type.steps
    .slice()
    .reverse()
    .slice(0, 5)
    .map((s, i) => `<text x="40" y="${300 + i * 44}" font-family="${esc(i < 3 ? type.display : type.text)}, Georgia, serif" font-size="${Math.min(40, s.px)}" fill="${c.ink}">${esc(i === 0 ? brief.name : `${s.name} · ${s.px}px`)}</text>`)
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" width="960" height="540">`,
    `<rect width="960" height="540" fill="${c.paper}"/>`,
    `<g transform="translate(40 40) scale(0.95)">${inner}</g>`,
    `<text x="330" y="54" font-family="system-ui, sans-serif" font-size="13" letter-spacing="2" fill="${c.ink}" opacity="0.6">PALETTE · ${palette.vibe.toUpperCase()}</text>`,
    swatches,
    checks,
    specimen,
    `<text x="330" y="370" font-family="system-ui, sans-serif" font-size="13" letter-spacing="2" fill="${c.ink}" opacity="0.6">TYPE · ${esc(type.display)} / ${esc(type.text)} · ratio ${type.ratio}</text>`,
    brief.tagline ? `<text x="330" y="400" font-family="${esc(type.text)}, system-ui, sans-serif" font-size="18" fill="${c.primary}">${esc(brief.tagline.slice(0, 70))}</text>` : "",
    `<rect x="0" y="520" width="960" height="20" fill="${c.primary}"/>`,
    `</svg>`,
  ].join("");
}
