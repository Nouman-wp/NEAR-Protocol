import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveKeyPair, signSettlement, type SignedIntent } from "@quorum/core";
import { Db } from "../src/db.ts";
import { SettlementError, Settlements } from "../src/settlements.ts";
import type { Chain } from "../src/chain.ts";
import type { Registry } from "../src/registry.ts";

const D = { contract: "clearing.q.test", token: "usdc.q.test", intents: "intents.q.test", intentsKind: "intents-lite" as const };
const account = (id: number) => `agent-${id}.q.test`;
const keys = (id: number) => deriveKeyPair("test", `agent-${id}`);

interface Opts {
  /** what `settle` does: true = executed, false = verifier refused, "throw" = the call itself failed */
  settle?: (signed: SignedIntent[]) => boolean | "throw";
  balance?: bigint;
  keyRegistered?: boolean;
  rpcTroubleAt?: number;
  positionState?: (agent: number) => string;
}

function setup(o: Opts = {}) {
  const db = new Db(mkdtempSync(join(tmpdir(), "quorum-stl-")));
  const writes: { method: string; args: { signed?: SignedIntent[]; agent_id?: number } }[] = [];
  const sealed = new Set<number>();
  const chain = {
    d: D,
    rpcTroubleAt: o.rpcTroubleAt ?? 0,
    blockTimeMs: async () => Date.now(),
    intentsKeyRegistered: async () => o.keyRegistered ?? true,
    intentsBalance: async () => o.balance ?? 1_000_000n,
    write: async (_label: string, method: string, args: { signed?: SignedIntent[]; agent_id?: number }) => {
      writes.push({ method, args });
      if (method === "settle") {
        const r = o.settle ? o.settle(args.signed!) : true;
        if (r === "throw") throw new Error("settle failed: transfer amount does not match the plan");
        return { hash: `tx${writes.length}`, value: r, gasBurnt: 0n, logs: [], receiptFailures: [] };
      }
      return { hash: `tx${writes.length}`, value: null, gasBurnt: 0n, logs: [], receiptFailures: [] };
    },
    position: async (_e: number, agent: number) => ({ state: o.positionState?.(agent) ?? "Owes" }),
    epoch: async (id: number) => ({ status: sealed.has(id) ? "Sealed" : "Finalized", receipt_hash: `0x${"ab".repeat(32)}` }),
  } as unknown as Chain;
  const registry = {
    get: (id: number | bigint) => ({ account: account(Number(id)), publicKey: keys(Number(id)).publicKey }),
    list: () => [],
    refreshCollateral: async () => undefined,
  } as unknown as Registry;
  const sealedCalls: number[] = [];
  const s = new Settlements(db, chain, registry, { chunkSize: 10, gatherMs: 5_000 }, (e) => sealedCalls.push(e));
  return { db, s, writes, sealed, sealedCalls };
}

/** Epoch 7 in settlement: agent 1 owes 500 to agent 3 and 350 to agent 4; agent 2 owes 200 to agent 4. */
function epoch(db: Db, s: Settlements, deadlineInMs = 60_000) {
  const now = Date.now();
  const deadline = now + deadlineInMs;
  db.run("INSERT INTO epochs(id, phase, starts_at, intake_ends_at, challenge_ends_at, settle_deadline) VALUES (7, 'settling', ?, ?, ?, ?)", now - 9e5, now - 8e5, now - 7e5, deadline);
  for (const [agent, net] of [[1, -850], [2, -200], [3, 500], [4, 550]] as const) {
    db.run("INSERT INTO positions(epoch, agent_id, credit, debit, net, state) VALUES (7, ?, 0, 0, ?, ?)", agent, net, net < 0 ? "owes" : "creditor");
  }
  s.createOrders(
    7,
    [
      { agentId: 1n, owed: 850n },
      { agentId: 2n, owed: 200n },
    ],
    deadline,
    [
      { from: 1n, to: 3n, amount: 500n },
      { from: 1n, to: 4n, amount: 350n },
      { from: 2n, to: 4n, amount: 200n },
    ],
  );
}

const sign = (s: Settlements, agent: number) => {
  const k = keys(agent);
  return signSettlement(s.order(s.get(`stl_7_${agent}`)!), k.secretKey, k.publicKey);
};
const status = (s: Settlements, agent: number) => s.get(`stl_7_${agent}`)!.status;
const settle = async (s: Settlements) => {
  await s.tick();
  await new Promise((r) => setTimeout(r, 20));
  await s.tick();
};

describe("settlement through NEAR Intents", () => {
  it("an order lists the debtor's lines of the plan with the creditors' accounts", () => {
    const { db, s } = setup();
    epoch(db, s);
    const o = s.order(s.get("stl_7_1")!);
    expect(o.account).toBe("agent-1.q.test");
    expect(o.verifier).toBe("intents.q.test");
    expect(o.transfers).toEqual([
      { to: "3", receiver: "agent-3.q.test", amount: "500" },
      { to: "4", receiver: "agent-4.q.test", amount: "350" },
    ]);
  });

  it("all debtors' payloads go to the contract in one settle call", async () => {
    const { db, s, writes, sealed, sealedCalls } = setup();
    epoch(db, s);
    await s.submit("stl_7_1", sign(s, 1));
    await s.submit("stl_7_2", sign(s, 2));
    sealed.add(7);
    await settle(s);
    const calls = writes.filter((w) => w.method === "settle");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.signed).toHaveLength(2);
    expect([status(s, 1), status(s, 2)]).toEqual(["recorded", "recorded"]);
    expect(s.transfers(7).every((t) => t.status === "settled" && t.tx)).toBe(true);
    expect(db.get<{ phase: string }>("SELECT phase FROM epochs WHERE id = 7")!.phase).toBe("sealed");
    expect(sealedCalls).toEqual([7]);
  });

  it("refuses a payload that does not match the plan before it costs a transaction", async () => {
    const { db, s, writes } = setup();
    epoch(db, s);
    const k = keys(1);
    const order = s.order(s.get("stl_7_1")!);
    const underpay = signSettlement({ ...order, transfers: [order.transfers[0]!, { ...order.transfers[1]!, amount: "349" }] }, k.secretKey, k.publicKey);
    await expect(s.submit("stl_7_1", underpay)).rejects.toThrow(/transfer 2 must pay 350/);
    const wrongCreditor = signSettlement({ ...order, transfers: [{ ...order.transfers[0]!, receiver: "mallory.q.test" }, order.transfers[1]!] }, k.secretKey, k.publicKey);
    await expect(s.submit("stl_7_1", wrongCreditor)).rejects.toThrow(/transfer 1 must pay 500/);
    const partial = signSettlement({ ...order, transfers: [order.transfers[0]!] }, k.secretKey, k.publicKey);
    await expect(s.submit("stl_7_1", partial)).rejects.toThrow(/plan has 2 transfer/);
    expect(writes).toHaveLength(0);
    expect(status(s, 1)).toBe("awaiting_payment");
  });

  it("refuses a payload signed by someone else or for another verifier", async () => {
    const { db, s } = setup();
    epoch(db, s);
    const order = s.order(s.get("stl_7_1")!);
    const stranger = keys(2);
    const forged = signSettlement(order, stranger.secretKey, stranger.publicKey);
    forged.payload.message = forged.payload.message.replace("agent-1", "agent-9");
    await expect(s.submit("stl_7_1", forged)).rejects.toThrow(SettlementError);
    const k = keys(1);
    const elsewhere = signSettlement({ ...order, verifier: "intents.near" }, k.secretKey, k.publicKey);
    await expect(s.submit("stl_7_1", elsewhere)).rejects.toThrow(/addressed to intents.near/);
  });

  it("refuses a debtor whose key or balance the verifier would reject", async () => {
    const poor = setup({ balance: 100n });
    epoch(poor.db, poor.s);
    await expect(poor.s.submit("stl_7_1", sign(poor.s, 1))).rejects.toThrow(/deposit the difference/);
    const noKey = setup({ keyRegistered: false });
    epoch(noKey.db, noKey.s);
    await expect(noKey.s.submit("stl_7_1", sign(noKey.s, 1))).rejects.toThrow(/add_public_key/);
  });

  it("when the verifier refuses a batch, each payload is retried alone and the bad one is sent back", async () => {
    // agent 2's transfer fails inside the verifier (say its balance moved); agent 1's is fine
    const { db, s, writes } = setup({ settle: (signed) => !signed.some((x) => x.payload.message.includes("agent-2.q.test")) });
    epoch(db, s);
    await s.submit("stl_7_1", sign(s, 1));
    await s.submit("stl_7_2", sign(s, 2));
    await settle(s);
    expect(writes.filter((w) => w.method === "settle").map((w) => w.args.signed!.length)).toEqual([2, 1, 1]);
    expect(status(s, 1)).toBe("recorded");
    expect(status(s, 2)).toBe("awaiting_payment");
    expect(s.get("stl_7_2")!.error).toMatch(/refused/);
  });

  it("trusts the chain when a settle call's answer was lost", async () => {
    const { db, s } = setup({ settle: () => "throw", positionState: () => "Settled" });
    epoch(db, s);
    await s.submit("stl_7_1", sign(s, 1));
    await s.submit("stl_7_2", sign(s, 2));
    await settle(s);
    expect([status(s, 1), status(s, 2)]).toEqual(["recorded", "recorded"]);
  });

  it("a debtor that never signs is defaulted after the deadline, once", async () => {
    const { db, s, writes, sealed } = setup();
    epoch(db, s, -10_000);
    await s.submit("stl_7_1", sign(s, 1)).catch(() => undefined); // too late to matter: still accepted and sent
    await settle(s);
    sealed.add(7);
    await settle(s);
    expect(writes.filter((w) => w.method === "declare_default").map((w) => w.args.agent_id)).toEqual([2]);
    expect(status(s, 2)).toBe("defaulted");
    expect(db.get<{ defaults: number }>("SELECT defaults FROM epochs WHERE id = 7")!.defaults).toBe(1);
    expect(s.transfers(7).find((t) => t.from_agent === 2)!.status).toBe("defaulted");
  });

  it("holds defaults while the RPC has been failing", async () => {
    const { db, s, writes } = setup({ rpcTroubleAt: Date.now() - 30_000 });
    epoch(db, s, -10_000);
    await settle(s);
    expect(writes.filter((w) => w.method === "declare_default")).toHaveLength(0);
    expect(status(s, 1)).toBe("awaiting_payment");
  });

  it("nobody is defaulted before the deadline", async () => {
    const { db, s, writes } = setup();
    epoch(db, s, 60_000);
    await settle(s);
    expect(writes).toHaveLength(0);
  });
});
