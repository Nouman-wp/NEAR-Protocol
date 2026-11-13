// Run the backend of a public deployment on this machine: clearing service + agent swarm +
// edge proxy (one port) [+ a Cloudflare quick tunnel].
//
//   pnpm serve testnet             uses .env.testnet and Blockchain/deployments/testnet.json
//   pnpm serve testnet --tunnel    also opens https://<random>.trycloudflare.com
//
// The tunnel URL is written to .data/tunnel-<network>.url; `pnpm publish:web` points the
// website's proxy at it. Any host with a public port can run this instead (Backend/deploy/).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, binIn, loadEnv, run, stopAll, useNetworkEnv, waitFor } from "./lib.mjs";
// @ts-expect-error plain ES module without types
import { startEdge } from "./edge.mjs";
import { readDeployment } from "./net.ts";

const network = process.argv[2] ?? "testnet";
const withTunnel = process.argv.includes("--tunnel");
useNetworkEnv(network);
const env = loadEnv();
if (!env.QUORUM_NETWORK || env.QUORUM_NETWORK === "local") throw new Error(`.env.${network} is not a public network config: run \`pnpm wallets ${network}\``);
if (!readDeployment(network)) throw new Error(`Blockchain/deployments/${network}.json is missing: run \`pnpm deploy:${network}\` first`);

const children: ReturnType<typeof run>[] = [];
const stop = () => {
  stopAll(children);
  setTimeout(() => process.exit(0), 600);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const shell = process.platform === "win32";
const port = Number(env.PORT ?? 8787);
const fleetPort = Number(env.FLEET_PORT ?? 8788);
const edgePort = Number(env.EDGE_PORT ?? 8790);

children.push(run("clearing", binIn("Backend/clearing", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "Backend", "clearing"), shell }));
await waitFor(() => fetch(`http://localhost:${port}/v1/config`).then((r) => r.ok), "clearing service", 180_000);
children.push(run("fleet", binIn("Blockchain/agents", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "Blockchain", "agents"), shell }));
startEdge({ port: edgePort, clearingPort: port, fleetPort });

if (withTunnel) {
  const exe = [join(homedir(), ".quorum", "bin", shell ? "cloudflared.exe" : "cloudflared"), "cloudflared"].find((p) => p === "cloudflared" || existsSync(p))!;
  const t = run("tunnel", exe, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${edgePort}`]);
  children.push(t);
  const onData = (d: Buffer) => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    mkdirSync(join(ROOT, ".data"), { recursive: true });
    writeFileSync(join(ROOT, ".data", `tunnel-${network}.url`), m[0]);
    console.log(`\n  tunnel  ${m[0]}  (written to .data/tunnel-${network}.url)\n`);
  };
  t.stdout?.on("data", onData);
  t.stderr?.on("data", onData);
}
console.log(`\n  Quorum ${network} backend\n  API    http://localhost:${port}/v1/stats\n  Swarm  http://localhost:${fleetPort}/control/status\n  Edge   http://localhost:${edgePort}\n  Ctrl+C to stop.\n`);
