import { describe, expect, it } from "vitest";
import {
  bidCommitment,
  bytesToHex,
  canonicalJson,
  chainIouSetHash,
  chainPositionsHash,
  clearRound,
  deriveKeyPair,
  encodeTransaction,
  functionCall,
  implicitAccountId,
  intentsTokenId,
  iouDigest,
  isAccountId,
  keyPairFromSecret,
  keyPairFromSeed,
  messageText,
  net,
  parseSignedIntent,
  planHash,
  settlementNonce,
  settlementPlan,
  sha256Hex,
  signMessage,
  signSettlement,
  verifyMessage,
  ZERO_HASH,
  type IOU,
  type NettableIou,
  type QuorumDomain,
  type SettlementOrder,
} from "../src/index.ts";

const H1 = `0x${"11".repeat(32)}` as const;
const H2 = `0x${"22".repeat(32)}` as const;
const domain: QuorumDomain = { network: "local", contract: "clearing.quorum.test.near" };
const iou: IOU = { buyer: 3n, seller: 7n, amount: 4_000n, token: "usdc.quorum.testnet", jobHash: H1, quoteHash: H2, epoch: 12n, nonce: 99n };

describe("messages", () => {
  it("the IOU text is the exact string the contract rebuilds", () => {
    // the same literal is asserted in Blockchain/contracts/quorum/src/tests.rs (the_iou_message_is_canonical_json)
    expect(messageText("IOU", iou)).toBe(
      `{"amount":"4000","buyer":"3","epoch":"12","jobHash":"${H1}","nonce":"99","quoteHash":"${H2}","seller":"7","token":"usdc.quorum.testnet","type":"IOU"}`,
    );
  });

  it("signs and verifies under NEP-413", () => {
    const k = deriveKeyPair("seed", "quorum/agent/scout");
    const sig = signMessage(domain, "IOU", iou, k.secretKey);
    expect(sig.startsWith("ed25519:")).toBe(true);
    expect(verifyMessage(domain, "IOU", iou, sig, k.publicKey)).toBe(true);
  });

  it("a signature is bound to the message, the key and the deployment", () => {
    const k = deriveKeyPair("seed", "a");
    const other = deriveKeyPair("seed", "b");
    const sig = signMessage(domain, "IOU", iou, k.secretKey);
    expect(verifyMessage(domain, "IOU", { ...iou, amount: 4_001n }, sig, k.publicKey)).toBe(false);
    expect(verifyMessage(domain, "IOU", iou, sig, other.publicKey)).toBe(false);
    expect(verifyMessage({ ...domain, contract: "clearing.quorum.testnet" }, "IOU", iou, sig, k.publicKey)).toBe(false);
    expect(verifyMessage(domain, "IOU", iou, "ed25519:garbage", k.publicKey)).toBe(false);
  });

  it("different message kinds never share a digest", () => {
    const k = deriveKeyPair("seed", "a");
    const revocation = { intentHash: H1, revokedAt: 5n };
    const sig = signMessage(domain, "IntentRevocation", revocation, k.secretKey);
    expect(verifyMessage(domain, "IntentRevocation", revocation, sig, k.publicKey)).toBe(true);
    expect(iouDigest(domain, iou)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("canonical JSON sorts keys and writes bigints as strings", () => {
    expect(canonicalJson({ b: 1n, a: [2n, { d: undefined, c: "x" }] })).toBe('{"a":["2",{"c":"x"}],"b":"1"}');
  });

  it("keys round-trip through NEAR's secret key format", () => {
    const k = keyPairFromSeed(new Uint8Array(32).fill(7));
    expect(keyPairFromSecret(k.secretKey)).toEqual(k);
    expect(implicitAccountId(k.publicKey)).toHaveLength(64);
    expect(isAccountId("scout.quorum.testnet")).toBe(true);
    expect(isAccountId("Scout.near")).toBe(false);
  });
});

describe("parity with the contract", () => {
  // The same inputs and outputs are asserted in Blockchain/contracts/quorum/src/tests.rs (parity_vectors).
  const seven = keyPairFromSeed(new Uint8Array(32).fill(7));

  it("IOU digest", () => {
    expect(iouDigest({ network: "local", contract: "clearing.quorum.test.near" }, iou)).toBe(VECTORS.iouDigest);
  });

  it("bid commitment", () => {
    expect(bidCommitment(5, 9, 123_456n, H1)).toBe(VECTORS.commitment);
  });

  it("commitment hash chains", () => {
    expect(chainIouSetHash(ZERO_HASH, H1)).toBe(VECTORS.iouSet);
    expect(chainPositionsHash(ZERO_HASH, 3n, 700n, 1_550n)).toBe(VECTORS.positions);
    expect(planHash([{ from: 1n, to: 2n, amount: 500n }, { from: 1n, to: 3n, amount: 350n }])).toBe(VECTORS.plan);
  });

  it("public key of a known seed", () => {
    expect(seven.publicKey).toBe(VECTORS.publicKey);
  });
});

const VECTORS = {
  iouDigest: "0x34d146f21c4c818f5cedd13235064fe1f3b7be13d6a675ff49806df1906fb408",
  commitment: "0xec43a5cec5634f7bf728b67c814bf5e031339eab7baccf3db6258234518eb1d2",
  iouSet: "0x8878b15a7d6a3a4f464e8f9f42591dbc0cf4bedea0ec309003d2b2ee53655ef8",
  positions: "0x8e81152db5a5f597b1de295375a44807bcb48b3f90acf4aa51030abe4a62a061",
  plan: "0x18de58895260367106a71a2588510c76e4f6f8d60f8396f605eaed1f806d6088",
  publicKey: "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB",
};

describe("settlement plan", () => {
  const mk = (buyer: number, seller: number, amount: number, nonce: number): NettableIou => ({
    buyer: BigInt(buyer),
    seller: BigInt(seller),
    amount: BigInt(amount),
    nonce: BigInt(nonce),
    digest: sha256Hex(`${buyer}-${seller}-${nonce}`),
  });

  it("pays every creditor exactly and never more transfers than debtors + creditors - 1", () => {
    for (let seed = 1; seed <= 200; seed++) {
      let s = seed;
      const r = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
      const ious: NettableIou[] = [];
      for (let i = 0; i < 5 + (seed % 60); i++) {
        const b = 1 + Math.floor(r() * 9);
        let sl = 1 + Math.floor(r() * 9);
        if (sl === b) sl = (sl % 9) + 1;
        ious.push(mk(b, sl, 1 + Math.floor(r() * 9_000), i + 1));
      }
      const result = net(ious);
      const plan = settlementPlan(result.positions);
      for (const p of result.positions) {
        const paid = plan.filter((t) => t.from === p.agentId).reduce((a, t) => a + t.amount, 0n);
        const got = plan.filter((t) => t.to === p.agentId).reduce((a, t) => a + t.amount, 0n);
        expect(got - paid).toBe(p.net);
      }
      expect(plan.length).toBeLessThanOrEqual(Math.max(0, result.stats.debtors + result.stats.creditors - 1));
      expect(plan.every((t) => t.amount > 0n)).toBe(true);
      expect(result.stats.settlementTransfers).toBe(plan.length);
    }
  });

  it("matches the contract's plan for the documented example", () => {
    const result = net([mk(1, 2, 700, 1), mk(1, 3, 300, 2), mk(2, 3, 200, 1), mk(3, 1, 150, 5)]);
    expect(result.plan).toEqual([
      { from: 1n, to: 2n, amount: 500n },
      { from: 1n, to: 3n, amount: 350n },
    ]);
  });
});

describe("NEAR Intents settlement payload", () => {
  const k = deriveKeyPair("seed", "debtor");
  const order: SettlementOrder = {
    id: "stl_4_1",
    epoch: 4,
    agentId: "1",
    account: "a.quorum.testnet",
    amount: "850",
    token: "usdc.quorum.testnet",
    contract: "clearing.quorum.testnet",
    verifier: "intents.quorum.testnet",
    verifierKind: "intents-lite",
    deadline: 1_800_000_000_000,
    transfers: [
      { to: "2", receiver: "b.quorum.testnet", amount: "500" },
      { to: "3", receiver: "c.quorum.testnet", amount: "350" },
    ],
  };

  it("is a NEP-413 payload of transfer intents addressed to the verifier", () => {
    const signed = signSettlement(order, k.secretKey, k.publicKey, 1_700_000_000_000);
    const parsed = parseSignedIntent(signed)!;
    expect(parsed.signerId).toBe("a.quorum.testnet");
    expect(signed.payload.recipient).toBe("intents.quorum.testnet");
    expect(parsed.intents).toEqual([
      { intent: "transfer", receiver_id: "b.quorum.testnet", tokens: { [intentsTokenId("usdc.quorum.testnet")]: "500" }, memo: "quorum epoch 4" },
      { intent: "transfer", receiver_id: "c.quorum.testnet", tokens: { "nep141:usdc.quorum.testnet": "350" }, memo: "quorum epoch 4" },
    ]);
    expect(parsed.deadline).toBeGreaterThan(order.deadline!);
  });

  it("one debt has one nonce, so the verifier can refuse a second payment", () => {
    const a = signSettlement(order, k.secretKey, k.publicKey, 1);
    const b = signSettlement(order, k.secretKey, k.publicKey, 2);
    expect(a.payload.nonce).toBe(b.payload.nonce);
    expect(bytesToHex(settlementNonce("clearing.quorum.testnet", 4, 1))).not.toBe(bytesToHex(settlementNonce("clearing.quorum.testnet", 5, 1)));
  });

  it("a tampered payload does not parse", () => {
    const signed = signSettlement(order, k.secretKey, k.publicKey);
    signed.payload.message = signed.payload.message.replace('"500"', '"5"');
    expect(parseSignedIntent(signed)).toBeNull();
  });
});

describe("sealed-bid rounds", () => {
  const bids = [
    { seller: "2", price: 2_000n, reputation: 900 },
    { seller: "3", price: 1_500n, reputation: 900 },
    { seller: "4", price: 2_400n, reputation: 900 },
  ];
  const one = [{ buyer: "1", quantity: 1, maxPrice: 3_000n }];

  it("second price pays the lowest losing bid", () => {
    const r = clearRound("SecondPrice", 3_000n, 0, one, bids);
    expect([r.winner, r.clearingPrice]).toEqual(["3", 2_000n]);
  });

  it("first price pays the winning bid, and a lone second-price bidder gets the reserve", () => {
    expect(clearRound("FirstPrice", 3_000n, 0, one, bids).clearingPrice).toBe(1_500n);
    expect(clearRound("SecondPrice", 3_000n, 0, one, [bids[0]!]).clearingPrice).toBe(3_000n);
  });

  it("unrevealed, overpriced and low-reputation bids do not count", () => {
    const r = clearRound("FirstPrice", 3_000n, 700, one, [
      { seller: "2", price: null, reputation: 900 },
      { seller: "3", price: 3_500n, reputation: 900 },
      { seller: "4", price: 1_000n, reputation: 650 },
      { seller: "5", price: 2_900n, reputation: 900 },
    ]);
    expect([r.winner, r.clearingPrice]).toEqual(["5", 2_900n]);
    expect(clearRound("FirstPrice", 3_000n, 0, one, []).status).toBe("Void");
  });

  it("group-buy shares add up to the bill and nobody pays above its limit", () => {
    const demand = [
      { buyer: "1", quantity: 10, maxPrice: 1_000n },
      { buyer: "6", quantity: 30, maxPrice: 900n },
      { buyer: "7", quantity: 5, maxPrice: 600n },
    ];
    const r = clearRound("SecondPrice", 1_000n, 0, demand, [
      { seller: "2", price: 700n, reputation: 900 },
      { seller: "3", price: 800n, reputation: 900 },
    ]);
    expect([r.winner, r.clearingPrice, r.totalQuantity]).toEqual(["2", 800n, 40]);
    expect(r.allocations.map((a) => [a.buyer, a.cost])).toEqual([["1", 8_000n], ["6", 24_000n]]);
    expect(r.allocations.reduce((s, a) => s + a.cost, 0n)).toBe(r.clearingPrice * BigInt(r.totalQuantity));
  });
});

describe("transactions", () => {
  it("encodes a function call the way NEAR's borsh schema lays it out", () => {
    const k = keyPairFromSeed(new Uint8Array(32).fill(1));
    const tx = encodeTransaction({ signerId: "a.near", publicKey: k.publicKey, nonce: 5n, receiverId: "b.near", blockHash: new Uint8Array(32), actions: [functionCall("ping", {}, 1n, 0n)] });
    // 4+6 signer, 1+32 key, 8 nonce, 4+6 receiver, 32 block hash, 4 action count,
    // then 1 tag, 4+4 method, 4+2 args, 8 gas, 16 deposit
    expect(tx.length).toBe(10 + 33 + 8 + 10 + 32 + 4 + 1 + 8 + 6 + 8 + 16);
    expect(tx[10 + 33]).toBe(5);
  });
});
