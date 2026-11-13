// Run only the local NEAR node (near-sandbox) on 127.0.0.1:3030 and keep it running.
//
//   pnpm chain
//
// near-sandbox has no Windows build. On Windows, run `pnpm chain` inside WSL and `pnpm dev`
// in Windows: WSL forwards localhost, so `pnpm dev` finds the node and uses it. Stopping
// this process wipes the chain; the next `pnpm dev` deploys fresh contracts.
import { startSandbox } from "./sandbox.ts";

const node = await startSandbox(Number(process.env.SANDBOX_PORT ?? 3030));
console.log(`chain   │ NEAR sandbox ${node.started ? "started" : "already running"} at ${node.rpcUrl}. Ctrl+C to stop.`);
const stop = () => void node.stop().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => undefined, 1 << 30);
