// Simulation mode: a group-buying market of scripted agents, start to finish, with no
// model calls anywhere.
//
//   pnpm sim                         20 buyers, 5 sellers, 8 rounds, seed 42
//   pnpm sim --rounds 12 --seed 7
//   pnpm sim --buyers 10 --sellers 3
//
// It starts a local NEAR sandbox, deploys the contracts, gives every agent its own
// sub-account, runs the rounds (open, join, sealed commit, reveal, close, all on chain),
// lets the epochs net and settle through the NEAR Intents verifier, checks the result
// against the chain, prints a report and exits 0 only if every check passed.
import { formatUnits } from "@yuki/core";
import { startLocalStack, waitForSwarm } from "./stack.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const ROUNDS = arg("rounds", 8);
const BUYERS = arg("buyers", 20);
const SELLERS = arg("sellers", 5);
const SEED = arg("seed", 42);
const VERBOSE = process.argv.includes("--verbose");
const ADMIN = "yuki-sim-admin";

const say = (m: string) => console.log(`\x1b[32msim\x1b[0m     │ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (units: string | number | bigint, d = 4) => `$${formatUnits(BigInt(units), d)}`;
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

interface Round {
  id: number;
  status: string;
  pricing: string;
  reservePrice: string;
  demand: { buyer: string; quantity: number; maxPrice: string }[];
  bids: { seller: string; price: string | null; invalid: string | null }[];
  winner: string | null;
  clearingPrice: string | null;
  totalQuantity: number;
  allocations: { buyer: string; quantity: number; cost: string; jobId: string | null }[];
  savings: string | null;
}
interface Epoch {
  id: number;
  phase: string;
  iouCount: number;
  grossVolume: string;
  netVolume: string;
  debtors: number;
  creditors: number;
  settlementTransfers: number;
  transfersAvoided: number;
  settleTx: string | null;
  defaults: number;
  error: string | null;
}

async function main() {
  const quiet = (line: string) => !VERBOSE && !/\[market\]|\[fleet\] (ready|serving)|failed|error/i.test(line);
  const stack = await startLocalStack({
    env: {
      FLEET_MODE: "market",
      SIM_AUTO: "off",
      FLEET_BACKGROUND: "off",
      SIM_BUYERS: String(BUYERS),
      SIM_SELLERS: String(SELLERS),
      SIM_SEED: String(SEED),
      ADMIN_TOKEN: ADMIN,
      EPOCH_INTAKE_SECONDS: "40",
      EPOCH_CHALLENGE_SECONDS: "5",
      DISPUTE_WINDOW_SECONDS: "3",
      ROUND_JOIN_SECONDS: "5",
      ROUND_COMMIT_SECONDS: "6",
      ROUND_REVEAL_SECONDS: "6",
      PORT: "8797",
      FLEET_PORT: "8798",
      PUBLIC_API_URL: "http://localhost:8797",
      PUBLIC_FLEET_URL: "http://localhost:8798",
      CLEARING_URL: "http://localhost:8797",
      FLEET_CONTROL_URL: "http://localhost:8798",
      DATA_DIR: ".data/sim",
    },
    quietFleet: quiet,
    quietClearing: (line) => !VERBOSE && !/netted|sealed|settled through|failed|error|defaulted/i.test(line),
  });
  const get = async <T>(path: string): Promise<T> => (await fetch(`${stack.api}${path}`)).json() as Promise<T>;
  let failed = false;
  try {
    say(`creating ${BUYERS} buyer and ${SELLERS} seller agents, each on its own sub-account (seed ${SEED})`);
    const swarm = await waitForSwarm(stack.fleet);
    say(`${swarm.agents.length} agents registered, collateralised and funded, e.g. ${swarm.agents.slice(0, 3).map((a) => a.account).join(", ")}`);
    const names = new Map((await get<{ agentId: string; name: string }[]>("/v1/agents")).map((a) => [a.agentId, a.name]));
    const name = (id: string | null) => (id ? (names.get(id) ?? `#${id}`) : "-");

    const start = async () => {
      const r = await fetch(`${stack.fleet}/control/start`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN }, body: JSON.stringify({ scenario: "group-buy" }) });
      if (!r.ok) throw new Error(`could not start a round: ${await r.text()}`);
    };
    say(`running ${ROUNDS} sealed-bid group-buy rounds`);
    for (let i = 0; i < ROUNDS; i++) {
      await start();
      await sleep(6_500); // rounds overlap: a new one opens while the last is still in its bidding windows
    }

    // wait for every round to close and every allocated buyer to have bought its share
    let rounds: Round[] = [];
    for (let i = 0; i < 120; i++) {
      rounds = (await get<Round[]>("/v1/rounds?limit=200")).sort((a, b) => a.id - b.id);
      const done = rounds.length >= ROUNDS && rounds.every((r) => r.status !== "Open" && r.allocations.every((a) => a.jobId));
      if (done) break;
      await sleep(1_000);
    }
    // then for every IOU to be netted, settled and sealed: the open epoch is closed early
    // rather than waited out, and the wait ends only when no IOU is left outside a sealed epoch
    let epochs: Epoch[] = [];
    let closedEarly = 0;
    for (let i = 0; i < 300; i++) {
      const current = await get<{ epoch: { id: number }; ious: unknown[] }>("/v1/epochs/current");
      if (current.ious.length > 0 && closedEarly !== current.epoch.id) {
        await fetch(`${stack.api}/v1/admin/close-epoch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN }, body: "{}" });
        closedEarly = current.epoch.id;
      }
      epochs = (await get<Epoch[]>("/v1/epochs?limit=50")).filter((e) => e.iouCount > 0 || e.phase !== "intake").sort((a, b) => a.id - b.id);
      const busy = epochs.filter((e) => e.iouCount > 0);
      if (current.ious.length === 0 && busy.length > 0 && epochs.every((e) => e.phase === "sealed" || e.phase === "intake")) break;
      await sleep(1_000);
    }
    epochs = epochs.filter((e) => e.iouCount > 0);
    let batches = 0;
    for (const e of epochs) {
      const detail = await get<{ txs: { kind: string }[] }>(`/v1/epochs/${e.id}`);
      batches += detail.txs.filter((t) => t.kind === "settle").length;
    }

    console.log("\n  Rounds");
    console.log(`  ${pad("#", 4)}${pad("pricing", 13)}${lpad("buyers", 7)}${lpad("hours", 7)}${lpad("bids", 6)}  ${pad("winner", 16)}${lpad("price/h", 10)}${lpad("allocated", 11)}${lpad("saved", 10)}`);
    for (const r of rounds) {
      const hours = r.demand.reduce((n, d) => n + d.quantity, 0);
      console.log(
        `  ${pad(r.id, 4)}${pad(r.pricing === "SecondPrice" ? "second price" : "first price", 13)}${lpad(r.demand.length, 7)}${lpad(hours, 7)}${lpad(r.bids.length, 6)}  ${pad(r.status === "Closed" ? name(r.winner) : "(void)", 16)}${lpad(r.clearingPrice ? usd(r.clearingPrice) : "-", 10)}${lpad(`${r.totalQuantity}h/${r.allocations.length}`, 11)}${lpad(r.savings ? usd(r.savings, 3) : "-", 10)}`,
      );
    }
    console.log("\n  Epochs");
    console.log(`  ${pad("#", 4)}${lpad("IOUs", 6)}${lpad("gross", 11)}${lpad("net", 11)}${lpad("debtors", 9)}${lpad("creditors", 11)}${lpad("transfers", 11)}${lpad("avoided", 9)}  settle tx`);
    for (const e of epochs) {
      console.log(
        `  ${pad(e.id, 4)}${lpad(e.iouCount, 6)}${lpad(usd(e.grossVolume, 3), 11)}${lpad(usd(e.netVolume, 3), 11)}${lpad(e.debtors, 9)}${lpad(e.creditors, 11)}${lpad(e.settlementTransfers, 11)}${lpad(e.transfersAvoided, 9)}  ${e.settleTx ?? (e.phase === "sealed" ? "(nothing owed)" : e.phase)}`,
      );
    }

    // ---------------------------------------------------------------- checks
    const checks: [string, boolean, string][] = [];
    const closed = rounds.filter((r) => r.status === "Closed");
    checks.push([`${ROUNDS} rounds ran`, rounds.length >= ROUNDS && rounds.every((r) => r.status !== "Open"), `${closed.length} closed, ${rounds.length - closed.length} void`]);
    const sharesOk = closed.every((r) => r.allocations.reduce((s, a) => s + BigInt(a.cost), 0n) === BigInt(r.clearingPrice!) * BigInt(r.totalQuantity));
    checks.push(["every buyer pays only its share", sharesOk, "allocated costs add up to price x quantity in every round"]);
    const limitsOk = closed.every((r) => r.allocations.every((a) => BigInt(r.demand.find((d) => d.buyer === a.buyer)!.maxPrice) >= BigInt(r.clearingPrice!)));
    checks.push(["nobody pays above its limit", limitsOk, "buyers whose limit is under the clearing price are left out"]);
    const cheapestWon = closed.every((r) => {
      const valid = r.bids.filter((b) => b.price !== null && !b.invalid).map((b) => BigInt(b.price!));
      const winnerBid = r.bids.find((b) => b.seller === r.winner)?.price;
      return winnerBid !== undefined && winnerBid !== null && valid.every((p) => p >= BigInt(winnerBid));
    });
    checks.push(["the lowest valid bid won every round", cheapestWon, "recomputed from the revealed bids"]);
    const bought = closed.every((r) => r.allocations.every((a) => a.jobId));
    checks.push(["every allocation became a signed IOU", bought, `${closed.reduce((n, r) => n + r.allocations.length, 0)} purchases`]);
    checks.push(["every epoch settled", epochs.length > 0 && epochs.every((e) => e.phase === "sealed" && e.defaults === 0), `${epochs.length} epoch(s) sealed, no defaults`]);
    const purchases = closed.reduce((n, r) => n + r.allocations.length, 0);
    const settledIous = epochs.reduce((n, e) => n + e.iouCount, 0);
    checks.push(["every purchase was netted and settled", settledIous === purchases, `${settledIous} IOUs in sealed epochs for ${purchases} purchases`]);
    let verified = 0;
    for (const e of epochs) {
      const v = await get<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>(`/v1/epochs/${e.id}/verify`);
      if (v.ok) verified++;
      else for (const c of v.checks.filter((c) => !c.ok)) say(`epoch ${e.id}: ${c.name} FAILED: ${c.detail}`);
    }
    checks.push(["independent re-check against the chain", verified === epochs.length, `${verified}/${epochs.length} epochs: signatures, netting, plan and settlement match the contract`]);

    console.log("\n  Checks");
    for (const [label, ok, detail] of checks) console.log(`  ${ok ? "\x1b[32mpass\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${pad(label, 42)} ${detail}`);
    failed = checks.some(([, ok]) => !ok);

    const ious = epochs.reduce((n, e) => n + e.iouCount, 0);
    const transfers = epochs.reduce((n, e) => n + e.settlementTransfers, 0);
    const saved = closed.reduce((s, r) => s + BigInt(r.savings ?? 0), 0n);
    console.log(
      `\n  ${BUYERS} buyers and ${SELLERS} sellers, ${closed.length} rounds closed, ${rounds.reduce((n, r) => n + r.bids.length, 0)} sealed bids.` +
        `\n  ${ious} IOUs settled with ${transfers} transfers in ${batches} verifier batch(es); buyers paid ${usd(saved, 3)} less than at the reserve price.` +
        `\n  No model was called: demand, limits and bids are scripted from seed ${SEED}.\n`,
    );
  } finally {
    await stack.stop();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`sim     │ failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
