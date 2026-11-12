// Shared helpers for the dev/deploy scripts. Plain Node, no dependencies.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The env file in use: QUORUM_ENV_FILE (e.g. .env.testnet) or .env. */
export function envPath() {
  return join(ROOT, process.env.QUORUM_ENV_FILE ?? ".env");
}

export function loadEnv() {
  const file = envPath();
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** `testnet` -> .env.testnet, `mainnet` -> .env.mainnet; sets QUORUM_ENV_FILE for child processes too. */
export function useNetworkEnv(name) {
  if (!name || name === "local") return;
  const file = name.startsWith(".env") ? name : `.env.${name}`;
  process.env.QUORUM_ENV_FILE = file;
  return file;
}

export async function waitFor(fn, label, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const COLORS = { chain: 90, deploy: 33, clearing: 35, fleet: 36, web: 34, sim: 32 };

/** Quote for cmd.exe when a path has spaces (Windows needs the shell to run .cmd files). */
const quote = (s) => (/[\s&()^]/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s);

export function run(name, cmd, args, opts = {}) {
  const shell = opts.shell ?? false;
  const child = shell
    ? spawn([cmd, ...args].map(quote).join(" "), { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) }, shell: true, windowsHide: true })
    : spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) }, windowsHide: true });
  const tag = `\x1b[${COLORS[name] ?? 37}m${name.padEnd(8)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim() && !(opts.quiet && opts.quiet(l))) out.write(tag + l + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

/** Path of a workspace package's local binary (tsx, vite). */
export function binIn(pkg, name) {
  return join(ROOT, pkg, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

export function stopAll(children) {
  for (const c of children) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
      else c.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}
