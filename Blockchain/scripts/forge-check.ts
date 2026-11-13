/**
 * Compile and test the smart contracts the Smart Contract Team delivers, exactly as delivered:
 * every template as the developer writes it, and as the budget coder sometimes does
 * (its key access check missing). Each clean contract must pass its own unit tests and
 * build to wasm; each sloppy one must fail precisely the tests that guard the check it lost.
 *
 * Needs Rust with the wasm32-unknown-unknown target. Usage: pnpm test:forge
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATES, sloppy, writeContract, writeTests, type ContractCode, type Template } from "../agents/src/work/contracts.ts";

const root = process.env.FORGE_DIR ?? join(tmpdir(), "quorum-forge-check");
const briefs: Record<Template, string> = { escrow: "Chai Point Escrow", token: "Chai Point Rewards", voting: "Chai Point Council" };

interface Crate {
  name: string;
  sloppy: boolean;
  tests: string[];
  /** tests that must fail: those expecting a panic message the sloppy code no longer raises */
  mustFail: string[];
}

function guardTests(testsRs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of testsRs.matchAll(/#\[should_panic\(expected = "([^"]+)"\)\]\s*fn (\w+)/g)) out.set(m[2]!, m[1]!);
  return out;
}

function write(code: ContractCode, name: string): string[] {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const f of code.files) writeFileSync(join(dir, f.path), f.path === "Cargo.toml" ? f.content.replace(/^name = ".*"$/m, `name = "${name}"`) : f.content);
  const suite = writeTests(code);
  writeFileSync(join(dir, suite.path), suite.content);
  return [suite.content, ...suite.cases];
}

rmSync(root, { recursive: true, force: true });
const crates: Crate[] = [];
for (const t of TEMPLATES) {
  const clean = writeContract({ template: t, name: briefs[t] });
  const bad = sloppy(clean);
  const [cleanTests, ...cases] = write(clean, clean.crate);
  write(bad, `${clean.crate}-sloppy`);
  const badLib = bad.files.find((f) => f.path === "src/lib.rs")!.content;
  const mustFail = [...guardTests(cleanTests!)].filter(([, msg]) => !badLib.includes(`"${msg}"`)).map(([name]) => name);
  if (mustFail.length === 0) throw new Error(`${t}: the sloppy variant removed no guarded check`);
  crates.push({ name: clean.crate, sloppy: false, tests: cases, mustFail: [] });
  crates.push({ name: `${clean.crate}-sloppy`, sloppy: true, tests: cases, mustFail });
}
// one workspace, so near-sdk compiles once for all six crates
writeFileSync(join(root, "Cargo.toml"), `[workspace]\nresolver = "2"\nmembers = [${crates.map((c) => `"${c.name}"`).join(", ")}]\n\n[profile.release]\ncodegen-units = 1\nopt-level = "z"\nlto = true\npanic = "abort"\noverflow-checks = true\n`);
console.log(`wrote ${crates.length} crates to ${root}`);

const cargo = (args: string[]) => spawnSync("cargo", args, { cwd: root, encoding: "utf8", env: { ...process.env, CARGO_TERM_COLOR: "never" } });

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

for (const c of crates) {
  const r = cargo(["test", "-p", c.name, "--no-fail-fast", "--", "--test-threads=1"]);
  const out = `${r.stdout}\n${r.stderr}`;
  if (/error(\[E\d+\])?:/.test(r.stderr) && !/test result/.test(out)) {
    console.log(out.split("\n").filter((l) => /error|-->/.test(l)).slice(0, 20).join("\n"));
    fail(`${c.name} does not compile`);
    continue;
  }
  const failed = new Set([...out.matchAll(/^test tests::(\w+)(?: - should panic)? \.\.\. FAILED$/gm)].map((m) => m[1]!));
  const result = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(out);
  const total = result ? Number(result[1]) + Number(result[2]) : 0;
  if (total !== c.tests.length) fail(`${c.name}: ran ${total} tests, expected ${c.tests.length}`);
  const expected = new Set(c.mustFail);
  const unexpected = [...failed].filter((n) => !expected.has(n));
  const missed = [...expected].filter((n) => !failed.has(n));
  if (unexpected.length) fail(`${c.name}: unexpected failures ${unexpected.join(", ")}`);
  if (missed.length) fail(`${c.name}: the tests did not catch the missing check (${missed.join(", ")} passed)`);
  if (!unexpected.length && !missed.length && total === c.tests.length) {
    console.log(c.sloppy ? `  pass  ${c.name}: ${failed.size} of ${total} tests fail, exactly the ones guarding the removed check (${[...failed].join(", ")})` : `  pass  ${c.name}: ${total}/${total} tests pass`);
  }
}

for (const c of crates.filter((x) => !x.sloppy)) {
  const r = cargo(["build", "-p", c.name, "--release", "--quiet", "--target", "wasm32-unknown-unknown"]);
  if (r.status === 0) console.log(`  pass  ${c.name}: builds to wasm`);
  else {
    console.log(r.stderr.split("\n").slice(-20).join("\n"));
    fail(`${c.name} does not build to wasm`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nevery delivered contract compiles, tests itself, and catches the sloppy variant");
process.exit(failures ? 1 : 0);
