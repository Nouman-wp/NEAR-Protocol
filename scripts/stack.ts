// Start the whole system on a local NEAR sandbox: node -> contracts -> clearing service -> swarm.
// Shared by `pnpm dev` (keeps running, plus the website) and `pnpm sim` (runs a scripted market and exits).
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ROOT, binIn, run, stopAll, waitFor } from "./lib.mjs";
import { deploy } from "./deploy.ts";
import { startSandbox } from "./sandbox.ts";

export interface Stack {
  api: string;
  fleet: string;
  children: ChildProcess[];
  stop: () => Promise<void>;
}

export interface StackOptions {
  env?: Record<string, string>;
  /** drop fleet log lines that match */
  quietFleet?: (line: string) => boolean;
  quietClearing?: (line: string) => boolean;
}

export async function startLocalStack(opts: StackOptions = {}): Promise<Stack> {
  const node = await startSandbox();
  console.log(`chain   │ NEAR sandbox at ${node.rpcUrl}${node.started ? "" : " (already running)"}`);
  process.env.NEAR_RPC_URL = node.rpcUrl;
  process.env.QUORUM_NETWORK = "local";
  await deploy("local");

  const env: Record<string, string> = { QUORUM_NETWORK: "local", NEAR_RPC_URL: node.rpcUrl, ...opts.env };
  const port = env.PORT ?? process.env.PORT ?? "8787";
  const fleetPort = env.FLEET_PORT ?? process.env.FLEET_PORT ?? "8788";
  const api = `http://localhost:${port}`;
  const fleet = `http://localhost:${fleetPort}`;
  const shell = process.platform === "win32";
  const children: ChildProcess[] = [];
  const stop = async () => {
    stopAll(children);
    await new Promise((r) => setTimeout(r, 400));
    await node.stop().catch(() => undefined);
  };
  try {
    children.push(run("clearing", binIn("services/clearing", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "services", "clearing"), shell, env, quiet: opts.quietClearing }));
    await waitFor(() => fetch(`${api}/v1/config`).then((r) => r.ok), "clearing service", 90_000);
    children.push(run("fleet", binIn("services/fleet", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "services", "fleet"), shell, env, quiet: opts.quietFleet }));
    return { api, fleet, children, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Resolves once every agent has its account, registration, collateral and intents. */
export async function waitForSwarm(fleet: string, timeoutMs = 10 * 60_000): Promise<{ agents: { slug: string; account: string }[] }> {
  return waitFor(
    async () => {
      const s = (await fetch(`${fleet}/control/status`).then((r) => r.json())) as { ready: boolean; agents: { slug: string; account: string }[] };
      return s.ready ? s : null;
    },
    "the swarm to register and fund every agent",
    timeoutMs,
  );
}
