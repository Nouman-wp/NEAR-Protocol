#!/usr/bin/env node
// Build the website and publish it to Vercel, with Vercel proxying the backend paths to the
// machine running `pnpm serve <network> --tunnel`:
//
//   /v1/*  /agents/*  /guest(s)/*  /control/*  /media/*   ->  <backend>
//
// so the public site, the API and every agent card (whose URLs are written on chain) live
// under one stable domain. Vercel does not proxy WebSockets, so the live feed
// connects to the backend directly.
//
//   pnpm publish:web testnet                                   backend = .data/tunnel-testnet.url
//   node Blockchain/scripts/publish-web.mjs testnet --backend https://x   any public backend URL
//   node Blockchain/scripts/publish-web.mjs testnet --site https://yuki-xi.vercel.app
//
// Needs the Vercel CLI, logged in, and Frontend/ linked to a project (`vercel link`).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const network = process.argv[2] ?? "testnet";
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const tunnelFile = join(ROOT, ".data", `tunnel-${network}.url`);
const backend = (arg("backend") ?? (existsSync(tunnelFile) ? readFileSync(tunnelFile, "utf8").trim() : "")).replace(/\/+$/, "");
if (!backend) throw new Error(`no backend URL: start \`pnpm serve ${network} --tunnel\` or pass --backend`);
const siteFile = join(ROOT, ".data", `site-${network}.url`);
const site = (arg("site") ?? (existsSync(siteFile) ? readFileSync(siteFile, "utf8").trim() : "")).replace(/\/+$/, "");

const web = join(ROOT, "Frontend");
const shell = process.platform === "win32";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: web, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell, ...opts });

// 1. build: REST through the site's own origin, the live feed straight to the backend
const env = {
  ...process.env,
  // "/" = the page's own origin, so every domain on the project (and its vercel.app alias) works
  VITE_YUKI_API: site ? "/" : backend,
  VITE_YUKI_FLEET: site ? "/" : backend,
  VITE_YUKI_WS: backend.replace(/^http/, "ws"),
};
console.log(`building for ${site || "(site URL not known yet)"} -> backend ${backend}`);
execFileSync(shell ? "pnpm.cmd" : "pnpm", ["run", "build"], { cwd: web, env, stdio: "inherit", shell });

// 2. routing: backend paths are proxied, everything else is the single-page app
const proxied = ["v1", "guest", "guests", "control", "media", "users"];
// agent cards and A2A endpoints live at /agents/<slug>; the site's own agent pages are
// /agents and /agents/<numeric id>, so only slug paths go to the backend
const agentSlug = ":slug([a-z][a-z0-9-]*)";
writeFileSync(
  join(web, "dist", "vercel.json"),
  JSON.stringify(
    {
      // dist/ is already built: no framework preset, no install, no build on Vercel's side
      framework: null,
      installCommand: "",
      buildCommand: "",
      outputDirectory: ".",
      cleanUrls: false,
      rewrites: [
        ...proxied.map((p) => ({ source: `/${p}/:path*`, destination: `${backend}/${p}/:path*` })),
        { source: `/agents/${agentSlug}`, destination: `${backend}/agents/:slug` },
        { source: `/agents/${agentSlug}/:path*`, destination: `${backend}/agents/:slug/:path*` },
        { source: "/(.*)", destination: "/index.html" },
      ],
      headers: [{ source: "/assets/(.*)", headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }] }],
    },
    null,
    2,
  ),
);

// 3. deploy the static build to the linked project
const link = JSON.parse(readFileSync(join(web, ".vercel", "project.json"), "utf8"));
const vercelEnv = { ...process.env, VERCEL_ORG_ID: link.orgId, VERCEL_PROJECT_ID: link.projectId };
const out = sh("vercel", ["deploy", "dist", "--prod", "--yes"], { env: vercelEnv });
let deployment;
try {
  deployment = JSON.parse(out).deployment.url;
} catch {
  deployment = out.match(/https:\/\/\S+/)?.[0];
}
console.log(`deployed ${deployment}`);

// 4. the project's production domain (its shortest alias), remembered for the next build
const ins = spawnSync("vercel", ["inspect", deployment], { cwd: web, env: vercelEnv, encoding: "utf8", shell });
const aliases = [...`${ins.stdout}${ins.stderr}`.matchAll(/https:\/\/[a-z0-9.-]+\.vercel\.app/g)].map((m) => m[0]).filter((u) => u !== deployment);
const prod = aliases.sort((x, y) => x.length - y.length)[0];
if (prod) {
  mkdirSync(join(ROOT, ".data"), { recursive: true });
  writeFileSync(siteFile, prod);
  console.log(`production ${prod}`);
  if (!site) console.log(`built against ${backend}; run again to serve the API from the site's own origin`);
}
