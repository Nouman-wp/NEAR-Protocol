// End-to-end test of the contracts on a real NEAR node (near-sandbox), with no services:
//
//   deploy -> agents on their own sub-accounts -> a sealed-bid tender and a group buy
//   -> signed IOUs posted and netted on chain -> one NEAR Intents batch settles the epoch
//   -> a second epoch where the debtor never pays and its collateral covers the creditors
//
//   pnpm test:chain
import assert from "node:assert/strict";
import {
  TGAS,
  NearAccount,
  bidCommitment,
  bytesToHex,
  intentsTokenId,
  iouDigest,
  net as netEpoch,
  randomBytes,
  signMessage,
  signSettlement,
  type Deployment,
  type IOU,
  type QuorumDomain,
  type SettlementOrder,
} from "@quorum/core";
import { deploy } from "./deploy.ts";
import { startSandbox } from "./sandbox.ts";
import { near, net, rootAccount, subAccount } from "./net.ts";

const step = (m: string) => console.log(`\x1b[36me2e\x1b[0m     │ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Agent {
  id: number;
  name: string;
  account: NearAccount;
}

async function main() {
  const node = await startSandbox();
  process.env.NEAR_RPC_URL = node.rpcUrl;
  process.env.SETTLEMENT_WINDOW = "8";
  try {
    const d = await deploy("local");
    const n = net("local");
    const root = rootAccount(n);
    const clearer = subAccount(n, "clearer");
    const domain: QuorumDomain = { network: "local", contract: d.contract };
    const tokenId = intentsTokenId(d.token);
    const view = <T>(method: string, args: unknown = {}) => n.rpc.view<T>(d.contract, method, args);
    /** Wait until the chain's own clock has passed `at`: block time can lag the wall clock. */
    const untilChain = async (at: number) => {
      for (;;) {
        if ((await n.rpc.latestBlock()).timestampMs > at + 300) return;
        await sleep(300);
      }
    };
    const round = (id: number) => view<{ join_deadline: number; commit_deadline: number; reveal_deadline: number }>("get_round", { round_id: id });
    const balance = async (a: Agent) => BigInt(await n.rpc.view<string>(d.intents, "mt_balance_of", { account_id: a.account.accountId, token_id: tokenId }));

    // ---------------------------------------------------------------- agents
    const names = ["alice", "bob", "carol", "dave", "erin"];
    const agents: Agent[] = await Promise.all(
      names.map(async (name) => {
        const account = subAccount(n, `e2e-${name}`);
        if (!(await n.rpc.account(account.accountId))) await root.createSubAccount(`e2e-${name}`, account.publicKey, near(5));
        return { id: 0, name, account };
      }),
    );
    await Promise.all(
      agents.map(async (a) => {
        const existing = await view<number | null>("agent_id_of", { account_id: a.account.accountId });
        a.id = existing ?? (await a.account.call<number>(d.contract, "register", { uri: `https://example.test/${a.name}` })).value;
        await a.account.call(d.token, "mint", { amount: "200000000" });
        // 50 tUSDC of collateral with the coordinator, 100 tUSDC of spending money inside the verifier
        await a.account.call(d.token, "ft_transfer_call", { receiver_id: d.contract, amount: "50000000", msg: "" }, { deposit: 1n, gas: 100n * TGAS });
        await a.account.call(d.token, "ft_transfer_call", { receiver_id: d.intents, amount: "100000000", msg: "" }, { deposit: 1n, gas: 100n * TGAS });
        await a.account.call(d.intents, "add_public_key", { public_key: a.account.publicKey }, { deposit: 1n });
      }),
    );
    const [alice, bob, carol, dave, erin] = agents as [Agent, Agent, Agent, Agent, Agent];
    step(`registered ${agents.map((a) => `${a.name}#${a.id}`).join(", ")}, each on its own sub-account`);
    assert.equal((await view<{ total: string }>("get_collateral", { agent_id: alice.id })).total, "50000000");
    assert.equal(await balance(alice), 100_000_000n);

    // ---------------------------------------------------------------- a sealed-bid tender
    const spec = bytesToHex(randomBytes(32));
    const open = await alice.account.call<number>(d.contract, "open_round", {
      kind: "Tender",
      pricing: "SecondPrice",
      service: "fact-check",
      spec_hash: spec,
      quantity: 1,
      reserve_price: "3000",
      min_reputation: 0,
      join_ms: 0,
      commit_ms: 4000,
      reveal_ms: 4000,
    });
    const tender = open.value;
    const sealed = [
      { a: bob, price: 2_000n },
      { a: carol, price: 1_500n },
      { a: dave, price: 2_400n },
    ].map((b) => ({ ...b, salt: bytesToHex(randomBytes(32)) }));
    await Promise.all(sealed.map((b) => b.a.account.call(d.contract, "commit_bid", { round_id: tender, commitment: bidCommitment(tender, b.a.id, b.price, b.salt) })));
    const tooEarly = await bob.account.call(d.contract, "reveal_bid", { round_id: tender, price: "2000", salt: sealed[0]!.salt }).then(
      () => null,
      (e: Error) => e.message,
    );
    assert.match(tooEarly ?? "", /commit window is still open/);
    await untilChain((await round(tender)).commit_deadline);
    const lie = await bob.account.call(d.contract, "reveal_bid", { round_id: tender, price: "1000", salt: sealed[0]!.salt }).then(
      () => null,
      (e: Error) => e.message,
    );
    assert.match(lie ?? "", /does not match the commitment/);
    await Promise.all(sealed.map((b) => b.a.account.call(d.contract, "reveal_bid", { round_id: tender, price: b.price.toString(), salt: b.salt })));
    const closed = (await erin.account.call<{ status: string; winner: number; clearing_price: string }>(d.contract, "close_round", { round_id: tender })).value;
    assert.deepEqual([closed.status, closed.winner, closed.clearing_price], ["Closed", carol.id, "2000"]);
    step(`tender #${tender}: three sealed bids, carol wins at the second price (2000); a changed bid and an early reveal were refused`);

    // ---------------------------------------------------------------- a group buy
    const gb = (
      await alice.account.call<number>(d.contract, "open_round", {
        kind: "GroupBuy",
        pricing: "FirstPrice",
        service: "gpu-hour",
        spec_hash: spec,
        quantity: 10,
        reserve_price: "1000",
        min_reputation: 0,
        join_ms: 3000,
        commit_ms: 4000,
        reveal_ms: 4000,
      })
    ).value;
    await bob.account.call(d.contract, "join_round", { round_id: gb, quantity: 30, max_price: "900" });
    await untilChain((await round(gb)).join_deadline);
    const gbBids = [
      { a: carol, price: 700n },
      { a: dave, price: 650n },
    ].map((b) => ({ ...b, salt: bytesToHex(randomBytes(32)) }));
    await Promise.all(gbBids.map((b) => b.a.account.call(d.contract, "commit_bid", { round_id: gb, commitment: bidCommitment(gb, b.a.id, b.price, b.salt) })));
    await untilChain((await round(gb)).commit_deadline);
    await Promise.all(gbBids.map((b) => b.a.account.call(d.contract, "reveal_bid", { round_id: gb, price: b.price.toString(), salt: b.salt })));
    const gbClosed = (await erin.account.call<{ winner: number; clearing_price: string; allocations: { buyer: number; cost: string }[] }>(d.contract, "close_round", { round_id: gb })).value;
    assert.equal(gbClosed.winner, dave.id);
    assert.deepEqual(gbClosed.allocations.map((a) => [a.buyer, a.cost]), [[alice.id, "6500"], [bob.id, "19500"]]);
    step(`group buy #${gb}: alice and bob pool 40 units, dave wins at 650, each buyer owes only its share`);

    // ---------------------------------------------------------------- epoch 1: IOUs, netting, Intents settlement
    const epoch = (await view<{ current_epoch: number }>("get_config")).current_epoch;
    let nonce = BigInt(Date.now());
    const mk = (buyer: Agent, seller: Agent, amount: bigint) => {
      const iou: IOU = { buyer: BigInt(buyer.id), seller: BigInt(seller.id), amount, token: d.token, jobHash: spec, quoteHash: spec, epoch: BigInt(epoch), nonce: nonce++ };
      return { iou, signature: signMessage(domain, "IOU", iou, buyer.account.keyPair.secretKey), digest: iouDigest(domain, iou) };
    };
    const ious = [
      mk(alice, carol, 2_000n), // the tender
      mk(alice, dave, 6_500n), // group-buy shares
      mk(bob, dave, 19_500n),
      mk(carol, alice, 1_200n), // unrelated trade back the other way
      mk(dave, erin, 4_000n),
      mk(erin, bob, 500n),
    ];
    const expected = netEpoch(ious.map((x) => ({ buyer: x.iou.buyer, seller: x.iou.seller, amount: x.iou.amount, nonce: x.iou.nonce, digest: x.digest })));
    const posted = expected.ordered.map((o) => ious.find((x) => x.digest === o.digest)!);
    const wire = (x: (typeof ious)[number]) => ({
      buyer: Number(x.iou.buyer),
      seller: Number(x.iou.seller),
      amount: x.iou.amount.toString(),
      job_hash: x.iou.jobHash,
      quote_hash: x.iou.quoteHash,
      epoch,
      nonce: x.iou.nonce.toString(),
      signature: x.signature,
    });
    assert.equal(await view<string>("iou_digest", { iou: wire(posted[0]!) }), posted[0]!.digest, "contract and TypeScript agree on the IOU digest");

    const forged = { ...wire(posted[0]!), amount: "1" };
    const refused = await clearer.call(d.contract, "post_ious", { epoch, ious: [forged] }, { gas: 100n * TGAS }).then(
      () => null,
      (e: Error) => e.message,
    );
    assert.match(refused ?? "", /bad IOU signature/);

    const post = await clearer.call(d.contract, "post_ious", { epoch, ious: posted.map(wire) }, { gas: 200n * TGAS });
    const fin = await clearer.call(d.contract, "finalize_epoch", { epoch, expected_iou_set_hash: expected.iouSetHash, expected_positions_hash: expected.positionsHash }, { gas: 200n * TGAS });
    const onchain = await view<{ status: string; plan: { from: number; to: number; amount: string }[]; plan_hash: string; net_volume: string }>("get_epoch", { epoch });
    assert.equal(onchain.status, "Finalized");
    assert.equal(onchain.plan_hash, expected.planHash, "contract and TypeScript agree on the settlement plan");
    assert.equal(onchain.net_volume, expected.stats.netVolume.toString());
    step(`epoch ${epoch}: ${ious.length} signed IOUs verified on chain (post ${Number(post.gasBurnt / TGAS)} Tgas, finalize ${Number(fin.gasBurnt / TGAS)} Tgas), netted into ${onchain.plan.length} transfers; a forged IOU was refused`);

    const before = new Map(await Promise.all(agents.map(async (a) => [a.id, await balance(a)] as const)));
    const byId = new Map(agents.map((a) => [a.id, a]));
    const debtors = [...new Set(onchain.plan.map((t) => t.from))];
    const orderFor = (id: number): SettlementOrder => ({
      id: `stl_${epoch}_${id}`,
      epoch,
      agentId: String(id),
      account: byId.get(id)!.account.accountId,
      amount: "0",
      token: d.token,
      contract: d.contract,
      verifier: d.intents,
      verifierKind: d.intentsKind,
      deadline: null,
      transfers: onchain.plan.filter((t) => t.from === id).map((t) => ({ to: String(t.to), receiver: byId.get(t.to)!.account.accountId, amount: t.amount })),
    });
    const signed = debtors.map((id) => signSettlement(orderFor(id), byId.get(id)!.account.keyPair.secretKey, byId.get(id)!.account.publicKey));

    const short = structuredClone(signed);
    const m = JSON.parse(short[0]!.payload.message);
    m.intents[0].tokens[tokenId] = "1";
    short[0]!.payload.message = JSON.stringify(m);
    const underpaid = await clearer.call(d.contract, "settle", { epoch, signed: short }, { gas: 300n * TGAS }).then(
      () => null,
      (e: Error) => e.message,
    );
    assert.match(underpaid ?? "", /does not match the plan/);

    const settle = await erin.account.call<boolean>(d.contract, "settle", { epoch, signed }, { gas: 300n * TGAS });
    assert.equal(settle.value, true);
    const sealedEpoch = await view<{ status: string; receipt_hash: string }>("get_epoch", { epoch });
    assert.equal(sealedEpoch.status, "Sealed");
    for (const p of expected.positions) {
      const a = byId.get(Number(p.agentId))!;
      assert.equal((await balance(a)) - before.get(a.id)!, p.net, `${a.name}'s balance moved by exactly its net position`);
    }
    step(`epoch ${epoch}: ${debtors.length} debtors' signed transfers executed by the verifier in one transaction (${Number(settle.gasBurnt / TGAS)} Tgas, tx ${settle.hash}); every balance moved by exactly its net position; an underpaying batch was refused`);

    const replay = await erin.account.call(d.intents, "execute_intents", { signed }, { gas: 100n * TGAS }).then(
      () => null,
      (e: Error) => e.message,
    );
    assert.match(replay ?? "", /nonce already used/);

    // ---------------------------------------------------------------- epoch 2: a default
    const epoch2 = epoch + 1;
    const late: IOU = { buyer: BigInt(alice.id), seller: BigInt(bob.id), amount: 7_000n, token: d.token, jobHash: spec, quoteHash: spec, epoch: BigInt(epoch2), nonce: nonce++ };
    const lateDigest = iouDigest(domain, late);
    const e2 = netEpoch([{ buyer: late.buyer, seller: late.seller, amount: late.amount, nonce: late.nonce, digest: lateDigest }]);
    await clearer.call(
      d.contract,
      "post_ious",
      { epoch: epoch2, ious: [{ buyer: alice.id, seller: bob.id, amount: "7000", job_hash: spec, quote_hash: spec, epoch: epoch2, nonce: late.nonce.toString(), signature: signMessage(domain, "IOU", late, alice.account.keyPair.secretKey) }] },
      { gas: 100n * TGAS },
    );
    await clearer.call(d.contract, "finalize_epoch", { epoch: epoch2, expected_iou_set_hash: e2.iouSetHash, expected_positions_hash: e2.positionsHash }, { gas: 100n * TGAS });
    const early = await erin.account.call(d.contract, "declare_default", { epoch: epoch2, agent_id: alice.id }, { gas: 200n * TGAS }).then(
      () => null,
      (e: Error) => e.message,
    );
    assert.match(early ?? "", /deadline has not passed/);
    const bobBefore = await balance(bob);
    await untilChain((await view<{ settle_deadline: number }>("get_epoch", { epoch: epoch2 })).settle_deadline);
    const def = await erin.account.call(d.contract, "declare_default", { epoch: epoch2, agent_id: alice.id }, { gas: 200n * TGAS });
    assert.deepEqual(def.receiptFailures, []);
    assert.equal((await balance(bob)) - bobBefore, 7_000n);
    assert.equal((await view<{ total: string }>("get_collateral", { agent_id: alice.id })).total, String(50_000_000 - 7_000));
    assert.equal((await view<{ status: string; default_count: number }>("get_epoch", { epoch: epoch2 })).status, "Sealed");
    step(`epoch ${epoch2}: alice never paid, so after the deadline her collateral paid bob in full, inside the verifier`);

    console.log("\n  chain e2e passed\n");
  } finally {
    await node.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
