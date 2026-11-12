// One command for the whole system on a local NEAR sandbox:
//   near-sandbox -> contracts -> clearing service -> agent swarm -> website
//
//   pnpm dev
//
// No accounts, keys or funds are needed: the sandbox starts with its own, and every key
// is derived from a public development seed. near-sandbox runs on Linux and macOS; on
// Windows use WSL. To run against testnet instead, see docs/DEPLOY.md.
import { join } from "node:path";
import { ROOT, binIn, loadEnv, run } from "./lib.mjs";
import { startLocalStack } from "./stack.ts";

const fileEnv = loadEnv();
const env: Record<string, string> = {
  EPOCH_INTAKE_SECONDS: "45",
  EPOCH_CHALLENGE_SECONDS: "12",
  DISPUTE_WINDOW_SECONDS: "8",
  ADMIN_TOKEN: "quorum-admin",
  ...fileEnv,
};

let stopping = false;
let stop: () => Promise<void> = async () => undefined;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  const stack = await startLocalStack({ env });
  stop = stack.stop;
  stack.children.push(run("web", binIn("apps/web", "vite"), [], { cwd: join(ROOT, "apps", "web"), shell: process.platform === "win32", env }));
  console.log(
    [
      "",
      "  Quorum is starting. The swarm needs about a minute to create and fund its accounts.",
      "  Website   http://localhost:5173",
      `  API       ${stack.api}/v1/stats`,
      `  Swarm     ${stack.fleet}/control/status`,
      "  Scenarios open the Live floor and use the scenario runner (admin token: quorum-admin)",
      "  Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
}

main().catch((e) => {
  console.error(`dev     │ ${(e as Error).message}`);
  shutdown();
});
