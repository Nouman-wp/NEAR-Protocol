// Start a local NEAR node (near-sandbox) on a fixed RPC port, unless one is already there.
// near-sandbox ships Linux and macOS binaries; on Windows run the project inside WSL.
import { NearRpc } from "@yuki/core";

export interface LocalNode {
  rpcUrl: string;
  /** true if this call started the node (a fresh chain) */
  started: boolean;
  stop: () => Promise<void>;
}

export async function startSandbox(port = 3030): Promise<LocalNode> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const up = await new NearRpc(rpcUrl, { timeoutMs: 1_500 }).latestBlock().then(
    () => true,
    () => false,
  );
  if (up) return { rpcUrl, started: false, stop: async () => undefined };
  if (process.platform === "win32") {
    throw new Error("near-sandbox has no Windows build. Run `pnpm dev` inside WSL (see Blockchain/scripts/wsl-setup.sh), or point YUKI_NETWORK at testnet.");
  }
  process.env.NEAR_RPC_TIMEOUT_SECS ??= "60";
  const { Sandbox } = await import("near-sandbox");
  const sandbox = await Sandbox.start({ config: { rpcPort: port } });
  return { rpcUrl: sandbox.rpcUrl, started: true, stop: () => sandbox.tearDown() };
}
