import {
  NearAccount,
  NearRpc,
  TGAS,
  intentDigest,
  intentsTokenId,
  signMessage,
  type AccountId,
  type Hex,
  type IntentMandate,
  type PublicKey,
  type Signature,
  type TxResult,
} from "@yuki/core";
import type { ClearingClient, ClearingConfig } from "./client.ts";

/**
 * The human (or company) side of an agent: a NEAR account that creates the agent's
 * sub-account, funds its collateral and its balance inside the verifier, signs AP2-style
 * intent mandates that bound what it may spend, and can pause, retire or withdraw. Every
 * call here is a transaction or a NEP-413 signature from the operator's key.
 */
export class Operator {
  readonly cfg: ClearingConfig;
  readonly near: NearAccount;

  constructor(cfg: ClearingConfig, accountId: AccountId, secretKey: string, rpcUrl = cfg.network.rpc) {
    this.cfg = cfg;
    this.near = new NearAccount(new NearRpc(rpcUrl), accountId, secretKey);
  }

  get accountId(): AccountId {
    return this.near.accountId;
  }

  get publicKey(): PublicKey {
    return this.near.publicKey;
  }

  private get contract(): AccountId {
    return this.cfg.deployment.contract;
  }

  // ---------------------------------------------------------------- accounts

  /** Create `<name>.<operator account>` with `publicKey` as its only key. No-op if it exists. */
  async ensureSubAccount(name: string, publicKey: PublicKey, yoctoNear: bigint): Promise<AccountId> {
    const id = `${name}.${this.accountId}`;
    if (!(await this.near.rpc.account(id))) await this.near.createSubAccount(name, publicKey, yoctoNear);
    return id;
  }

  /** Top an account's NEAR balance up to `target` yoctoNEAR, for gas. */
  async topUpNear(account: AccountId, target: bigint): Promise<bigint> {
    const state = await this.near.rpc.account(account);
    const have = state?.amount ?? 0n;
    if (have >= target) return 0n;
    await this.near.transfer(account, target - have);
    return target - have;
  }

  // ---------------------------------------------------------------- tokens and collateral

  async tokenBalance(who: AccountId = this.accountId): Promise<bigint> {
    return BigInt(await this.near.view<string>(this.cfg.deployment.token, "ft_balance_of", { account_id: who }));
  }

  /** Local and testnet deployments only: mint test USDC from the open faucet (10,000 per call). */
  async mintTestTokens(to: AccountId, amount: bigint): Promise<void> {
    if (!this.cfg.deployment.mockToken) throw new Error("this deployment settles in a real token: there is no faucet");
    const cap = 10_000_000_000n;
    for (let left = amount; left > 0n; left -= cap) {
      await this.near.call(this.cfg.deployment.token, "mint", { account_id: to, amount: (left > cap ? cap : left).toString() });
    }
  }

  transferToken(to: AccountId, amount: bigint): Promise<TxResult> {
    return this.near.call(this.cfg.deployment.token, "ft_transfer", { receiver_id: to, amount: amount.toString() }, { deposit: 1n });
  }

  async collateral(agentId: bigint): Promise<{ total: bigint; locked: bigint; pendingWithdrawal: bigint; available: bigint }> {
    const c = await this.near.view<{ total: string; locked: string; pending_withdrawal: string }>(this.contract, "get_collateral", { agent_id: Number(agentId) });
    const total = BigInt(c.total);
    const locked = BigInt(c.locked);
    const pendingWithdrawal = BigInt(c.pending_withdrawal);
    return { total, locked, pendingWithdrawal, available: total - locked - pendingWithdrawal };
  }

  /** Deposit collateral for an agent from the operator's own token balance. */
  deposit(agentId: bigint, amount: bigint): Promise<TxResult> {
    return this.near.call(this.cfg.deployment.token, "ft_transfer_call", { receiver_id: this.contract, amount: amount.toString(), msg: agentId.toString() }, { deposit: 1n, gas: 100n * TGAS });
  }

  /** Top the agent's free collateral up to `target` (no-op if already there). */
  async topUpCollateral(agentId: bigint, target: bigint): Promise<bigint> {
    const acc = await this.collateral(agentId);
    if (acc.available >= target) return 0n;
    const need = target - acc.available;
    await this.deposit(agentId, need);
    return need;
  }

  async intentsBalance(account: AccountId): Promise<bigint> {
    return BigInt(await this.near.view<string>(this.cfg.deployment.intents, "mt_balance_of", { account_id: account, token_id: intentsTokenId(this.cfg.deployment.token) }));
  }

  /** Deposit into the verifier on behalf of `account`: the money its settlement transfers draw on. */
  depositToIntents(account: AccountId, amount: bigint): Promise<TxResult> {
    return this.near.call(this.cfg.deployment.token, "ft_transfer_call", { receiver_id: this.cfg.deployment.intents, amount: amount.toString(), msg: account }, { deposit: 1n, gas: 100n * TGAS });
  }

  /** Top an account's balance inside the verifier up to `target`. */
  async topUpIntents(account: AccountId, target: bigint): Promise<bigint> {
    const have = await this.intentsBalance(account);
    if (have >= target) return 0n;
    await this.depositToIntents(account, target - have);
    return target - have;
  }

  // ---------------------------------------------------------------- agent control

  requestWithdrawal = (agentId: bigint, amount: bigint) => this.near.call(this.contract, "request_withdrawal", { agent_id: Number(agentId), amount: amount.toString() });
  withdraw = (agentId: bigint) => this.near.call(this.contract, "withdraw", { agent_id: Number(agentId) }, { gas: 60n * TGAS });
  pause = (agentId: bigint) => this.near.call(this.contract, "set_status", { agent_id: Number(agentId), status: "Paused" });
  unpause = (agentId: bigint) => this.near.call(this.contract, "set_status", { agent_id: Number(agentId), status: "Active" });
  retire = (agentId: bigint) => this.near.call(this.contract, "set_status", { agent_id: Number(agentId), status: "Retired" });
  setUri = (agentId: bigint, uri: string) => this.near.call(this.contract, "set_uri", { agent_id: Number(agentId), uri });

  // ---------------------------------------------------------------- intents (AP2 mandates)

  signIntent(intent: Omit<IntentMandate, "operator" | "operatorKey">): { intent: IntentMandate; signature: Signature; id: Hex } {
    const full: IntentMandate = { ...intent, operator: this.accountId, operatorKey: this.publicKey };
    return { intent: full, signature: signMessage(this.cfg.domain, "IntentMandate", full, this.near.keyPair.secretKey), id: intentDigest(this.cfg.domain, full) };
  }

  /** Sign and register an intent with the clearing service. */
  async authorise(client: ClearingClient, intent: Omit<IntentMandate, "operator" | "operatorKey">) {
    const { intent: full, signature } = this.signIntent(intent);
    return client.createIntent({
      intent: {
        ...full,
        buyer: full.buyer.toString(),
        budget: full.budget.toString(),
        perJobCap: full.perJobCap.toString(),
        allowedSellers: full.allowedSellers.map(String),
        notBefore: full.notBefore.toString(),
        deadline: full.deadline.toString(),
        nonce: full.nonce.toString(),
      },
      signature,
    });
  }

  async revoke(client: ClearingClient, intentId: Hex) {
    const revokedAt = BigInt(Math.floor(Date.now() / 1000));
    const signature = signMessage(this.cfg.domain, "IntentRevocation", { intentHash: intentId, revokedAt }, this.near.keyPair.secretKey);
    return client.revokeIntent(intentId, { revokedAt: revokedAt.toString(), signature });
  }
}
