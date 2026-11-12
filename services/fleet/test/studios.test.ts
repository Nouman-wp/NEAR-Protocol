import { describe, expect, it } from "vitest";
import { contrast, makeBrandSheet, makeLogo, makePalette, makeTypeScale, VIBES } from "../src/work/design.ts";
import { audit, sloppy, TEMPLATES, writeContract, writeTests } from "../src/work/contracts.ts";
import { crossCheck, lintSpec, resourceOf, writeCode, writeSchema, writeSpec } from "../src/work/backend.ts";
import { autoLevels, decodeJpeg, encodeJpeg, grade, GRADES, reframe, retouch, stats, syntheticScene } from "../src/work/image.ts";
import { captions, kenBurns, MOVES, wrap, type Storyboard } from "../src/work/video.ts";
import { FREELANCERS, ROLES, STUDIOS } from "../src/agents/studios.ts";

describe("design studio work", () => {
  it("every vibe gives a palette whose pairs pass WCAG AA", () => {
    for (const vibe of VIBES) {
      for (const name of ["Monsoon Coffee", "Glacier Labs", "A", "Pixel Arcade 2049"]) {
        const p = makePalette({ name, vibe });
        expect(p.swatches).toHaveLength(5);
        for (const pair of p.pairs) {
          expect(pair.aa, `${vibe}/${name}: ${pair.use} ${pair.ratio}`).toBe(true);
          expect(contrast(pair.fg, pair.bg)).toBe(pair.ratio);
        }
      }
    }
  });

  it("the same brief gives the same brand", () => {
    const b = { name: "Terra Market" };
    expect(makePalette(b)).toEqual(makePalette(b));
    expect(makeLogo(b, makePalette(b)).svg).toBe(makeLogo(b, makePalette(b)).svg);
  });

  it("the type scale grows by its ratio and the sheet embeds the logo", () => {
    const b = { name: "Glacier Labs", vibe: "cool" as const, tagline: "Cold storage" };
    const t = makeTypeScale(b);
    expect(t.steps[2]!.px / t.steps[1]!.px).toBeCloseTo(t.ratio, 2);
    const logo = makeLogo(b, makePalette(b));
    const sheet = makeBrandSheet(b, makePalette(b), t, logo.svg);
    expect(sheet.startsWith("<svg")).toBe(true);
    expect(sheet).toContain("Cold storage");
  });
});

describe("contract studio work", () => {
  it("every template passes the audit and its tests cover guards", () => {
    for (const template of TEMPLATES) {
      const code = writeContract({ name: `Test ${template}`, template });
      const src = code.files.find((f) => f.path === "src/lib.rs")!.content;
      const a = audit(src);
      expect(a.pass, a.findings.map((f) => f.message).join("; ")).toBe(true);
      expect(a.findings.filter((f) => f.severity === "medium" || f.severity === "high")).toEqual([]);
      const t = writeTests(code);
      expect(t.cases.length).toBeGreaterThanOrEqual(5);
      expect(t.guards.some((g) => g.covered)).toBe(true);
    }
  });

  it("the audit catches a removed access check in every template", () => {
    for (const template of TEMPLATES) {
      const bad = sloppy(writeContract({ name: `Test ${template}`, template }));
      const a = audit(bad.files.find((f) => f.path === "src/lib.rs")!.content);
      expect(a.pass).toBe(false);
      expect(a.findings.some((f) => f.severity === "high")).toBe(true);
    }
  });

  it("finds a payable method that ignores the deposit and a shared storage prefix", () => {
    const src = `#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct C { a: LookupMap<u64, u64>, b: LookupMap<u64, u64> }
#[near]
impl C {
    #[init]
    pub fn new() -> Self { Self { a: LookupMap::new(b"x"), b: LookupMap::new(b"x") } }
    #[payable]
    pub fn tip(&mut self) {}
    pub fn on_done(&mut self) {}
}`;
    const rules = audit(src).findings.map((f) => f.rule);
    expect(rules).toContain("payable-ignores-deposit");
    expect(rules).toContain("storage-prefix-collision");
    expect(rules).toContain("public-callback");
  });
});

describe("backend studio work", () => {
  it("spec, schema and code agree for the built-in resources", () => {
    for (const resource of ["booking", "order", "task", "invoice"]) {
      const r = resourceOf({ resource });
      const spec = writeSpec(r);
      expect(lintSpec(spec)).toEqual([]);
      const schema = writeSchema(r);
      const code = writeCode(r, spec);
      expect(code.handlers).toHaveLength(5);
      expect(crossCheck(r, spec, schema, code)).toEqual([]);
    }
  });

  it("the cross-check notices a missing handler", () => {
    const r = resourceOf({ resource: "booking" });
    const spec = writeSpec(r);
    const code = writeCode(r, spec);
    const broken = { ...code, content: code.content.replace("// deleteBooking\n", "") };
    expect(crossCheck(r, spec, writeSchema(r), broken)).toContain("no handler for deleteBooking");
  });
});

describe("photo studio work", () => {
  const scene = syntheticScene(240, 160, 3);

  it("JPEG round trip keeps the size", () => {
    const back = decodeJpeg(encodeJpeg(scene));
    expect([back.width, back.height]).toEqual([240, 160]);
  });

  it("auto levels stretch the histogram and retouching raises contrast", () => {
    const flat = { ...scene, data: scene.data.map((v, i) => (i % 4 === 3 ? 255 : 100 + Math.round(v / 6))) };
    expect(stats(autoLevels(flat)).contrast).toBeGreaterThan(stats(flat).contrast * 2);
    expect(stats(retouch(flat)).contrast).toBeGreaterThan(stats(flat).contrast);
  });

  it("every grade keeps the size and noir is grey", () => {
    for (const look of GRADES) expect(grade(scene, look).data.length).toBe(scene.data.length);
    const noir = grade(scene, "noir").data;
    for (let i = 0; i < noir.length; i += 4 * 97) expect(noir[i]).toBe(noir[i + 1]);
  });

  it("reframes to each format's shape inside the source", () => {
    for (const fmt of ["square", "story", "banner"] as const) {
      const r = reframe(scene, fmt);
      expect(r.window.x + r.window.w).toBeLessThanOrEqual(scene.width);
      expect(r.window.y + r.window.h).toBeLessThanOrEqual(scene.height);
      expect(r.width).toBeLessThanOrEqual(r.window.w);
    }
    const sq = reframe(scene, "square");
    expect(sq.width).toBe(sq.height);
  });
});

describe("video studio work", () => {
  const board: Storyboard = {
    title: "Monsoon",
    topic: "Monsoon",
    look: "film",
    fps: 6,
    width: 240,
    height: 135,
    titleSeconds: 1,
    crossfadeSeconds: 0.5,
    shots: MOVES.map((move, i) => ({ n: i + 1, image: null, source: null, move, seconds: 2, caption: `Scene ${i + 1} of a long caption that has to wrap onto a second line somewhere sensible.` })),
    totalSeconds: 9,
  };

  it("Ken Burns frames have the output size for every move", () => {
    const src = syntheticScene(320, 200, 1);
    for (const m of MOVES) {
      const f = kenBurns(src, m, 0.5, 240, 135);
      expect([f.width, f.height]).toEqual([240, 135]);
    }
  });

  it("captions pass their own checks and wrap to two lines", () => {
    const c = captions(board);
    expect(c.checks.every((x) => x.ok)).toBe(true);
    expect(c.vtt.startsWith("WEBVTT")).toBe(true);
    expect(c.cues).toHaveLength(board.shots.length + 1);
    for (const line of wrap("a ".repeat(80))) expect(line.length).toBeLessThanOrEqual(42);
  });
});

describe("studio catalogue", () => {
  it("every role has at least two freelancers who bid on it, and every lead can afford its reserves", () => {
    for (const s of STUDIOS) {
      const reserves = s.roles.reduce((a, r) => a + ROLES[r]!.reserve, 0n);
      expect(s.price).toBeGreaterThan(reserves);
      for (const r of s.roles) expect(FREELANCERS.filter((f) => f.skills[r]).length, r).toBeGreaterThanOrEqual(2);
    }
  });

  it("auditors never write contract code, so nobody audits their own work", () => {
    for (const f of FREELANCERS) expect(!!(f.skills["contract-audit"] && f.skills["contract-code"]), f.slug).toBe(false);
  });
});
