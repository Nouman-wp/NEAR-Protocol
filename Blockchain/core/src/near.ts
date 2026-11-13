import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { concatBytes, fromBase64, keyPairFromSecret, publicKeyBytes, sha256Bytes, toBase64, u128le, u32le, u64le, type AccountId, type KeyPair, type PublicKey } from "./crypto.ts";

/**
 * A small NEAR client: JSON-RPC, transaction encoding and signing. It covers what Quorum
 * needs (views, function calls, sub-accounts, deploys) and nothing else, runs in Node and
 * in the browser, and keeps one nonce sequence per account so an agent never races itself.
 */

export const TGAS = 1_000_000_000_000n;
export const ONE_NEAR = 10n ** 24n;
export const ONE_YOCTO = 1n;
/** the longest a send waits for a transaction it could not confirm straight away */
const TX_WAIT_MS = 60_000;

const utf8 = new TextEncoder();

export type Action =
  | { type: "createAccount" }
  | { type: "deployContract"; code: Uint8Array }
  | { type: "functionCall"; method: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { type: "transfer"; deposit: bigint }
  | { type: "addFullAccessKey"; publicKey: PublicKey }
  | { type: "deleteAccount"; beneficiary: AccountId };

export function functionCall(method: string, args: unknown = {}, gas = 30n * TGAS, deposit = 0n): Action {
  return { type: "functionCall", method, args: utf8.encode(JSON.stringify(args)), gas, deposit };
}

const str = (s: string) => {
  const b = utf8.encode(s);
  return concatBytes(u32le(b.length), b);
};
const key = (pk: PublicKey) => concatBytes(new Uint8Array([0]), publicKeyBytes(pk));

function encodeAction(a: Action): Uint8Array {
  switch (a.type) {
    case "createAccount":
      return new Uint8Array([0]);
    case "deployContract":
      return concatBytes(new Uint8Array([1]), u32le(a.code.length), a.code);
    case "functionCall":
      return concatBytes(new Uint8Array([2]), str(a.method), u32le(a.args.length), a.args, u64le(a.gas), u128le(a.deposit));
    case "transfer":
      return concatBytes(new Uint8Array([3]), u128le(a.deposit));
    case "addFullAccessKey":
      // AddKey { public_key, access_key { nonce: 0, permission: FullAccess } }
      return concatBytes(new Uint8Array([5]), key(a.publicKey), u64le(0n), new Uint8Array([1]));
    case "deleteAccount":
      return concatBytes(new Uint8Array([7]), str(a.beneficiary));
  }
}

export function encodeTransaction(tx: { signerId: AccountId; publicKey: PublicKey; nonce: bigint; receiverId: AccountId; blockHash: Uint8Array; actions: Action[] }): Uint8Array {
  return concatBytes(str(tx.signerId), key(tx.publicKey), u64le(tx.nonce), str(tx.receiverId), tx.blockHash, u32le(tx.actions.length), ...tx.actions.map(encodeAction));
}

export class NearError extends Error {
  /** the contract's own panic message, when there is one */
  readonly panic: string | null;
  readonly kind: string;
  constructor(message: string, kind = "unknown", panic: string | null = null) {
    super(message);
    this.kind = kind;
    this.panic = panic;
  }
}

export interface TxResult<T = unknown> {
  hash: string;
  /** the JSON value the call returned, if any */
  value: T;
  logs: string[];
  gasBurnt: bigint;
  /** panic messages of receipts that failed without failing the transaction (detached promises) */
  receiptFailures: string[];
}

export interface RpcOptions {
  /** called whenever the RPC fails or rate-limits, so callers can tell an outage from a real error */
  onTrouble?: (reason: string) => void;
  timeoutMs?: number;
}

export class NearRpc {
  /** Every endpoint, from a comma-separated list. One is used until it fails or rate-limits. */
  readonly urls: string[];
  private readonly opts: RpcOptions;
  private id = 0;
  private block: { hash: Uint8Array; at: number } | null = null;
  private current = 0;
  private coolUntil: number[];

  constructor(url: string, opts: RpcOptions = {}) {
    this.urls = url.split(",").map((u) => u.trim()).filter(Boolean);
    if (!this.urls.length) throw new Error("no RPC URL");
    this.coolUntil = this.urls.map(() => 0);
    this.opts = opts;
  }

  /** The endpoint in use. */
  get url(): string {
    return this.urls[this.current]!;
  }

  /** The endpoint in use, or the next one that is not cooling down after a failure. */
  private pick(): number {
    const now = Date.now();
    for (let k = 0; k < this.urls.length; k++) {
      const i = (this.current + k) % this.urls.length;
      if (this.coolUntil[i]! <= now) return (this.current = i);
    }
    return (this.current = this.coolUntil.indexOf(Math.min(...this.coolUntil)));
  }

  private anyAvailable(): boolean {
    const now = Date.now();
    return this.coolUntil.some((t) => t <= now);
  }

  async request<T>(method: string, params: unknown, attempts = 6): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      let retryAfterMs = 0;
      const at = this.pick();
      try {
        const res = await fetch(this.urls[at]!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? (method === "tx" ? 15_000 : 40_000)),
        });
        if (res.status === 429 || res.status >= 500) {
          // public RPCs rate-limit bursts: honour Retry-After when given, otherwise back off exponentially
          retryAfterMs = Math.min(10_000, Number(res.headers.get("retry-after") ?? 0) * 1000);
          throw new NearError(`RPC answered ${res.status}`, "rpc");
        }
        const body = (await res.json()) as { result?: T; error?: { name?: string; cause?: { name?: string; info?: unknown }; message?: string; data?: unknown } };
        if (body.error) {
          const cause = body.error.cause?.name ?? body.error.name ?? "RPC_ERROR";
          const detail = typeof body.error.data === "string" ? body.error.data : JSON.stringify(body.error.data ?? body.error.cause?.info ?? body.error.message ?? "");
          throw new NearError(`${cause}: ${detail}`, cause);
        }
        return body.result as T;
      } catch (err) {
        last = err;
        const kind = err instanceof NearError ? err.kind : "network";
        const transient = kind === "network" || kind === "rpc" || kind === "TIMEOUT_ERROR" || kind === "INTERNAL_ERROR" || (err as Error).name === "TimeoutError";
        if (transient) {
          this.opts.onTrouble?.((err as Error).message);
          // rest this endpoint; with several configured, the next attempt goes to another one
          if (this.urls.length > 1) this.coolUntil[at] = Date.now() + Math.max(retryAfterMs, kind === "rpc" ? 30_000 : 5_000);
        }
        if (!transient || method === "send_tx" || method === "broadcast_tx_commit") throw err;
        if (i + 1 < attempts && !this.anyAvailable()) await new Promise((r) => setTimeout(r, Math.max(retryAfterMs, kind === "rpc" ? Math.min(8_000, 500 * 2 ** i) : 400 * (i + 1))));
      }
    }
    throw last;
  }

  /** Call a view method and parse its JSON result. */
  async view<T>(contract: AccountId, method: string, args: unknown = {}): Promise<T> {
    const res = await this.request<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contract,
      method_name: method,
      args_base64: toBase64(utf8.encode(JSON.stringify(args))),
    });
    const text = new TextDecoder().decode(Uint8Array.from(res.result));
    return (text.length ? JSON.parse(text) : null) as T;
  }

  /** The account's balance and code hash, or null if it does not exist. */
  async account(accountId: AccountId): Promise<{ amount: bigint; codeHash: string; storageUsage: number } | null> {
    try {
      const a = await this.request<{ amount: string; code_hash: string; storage_usage: number }>("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
      return { amount: BigInt(a.amount), codeHash: a.code_hash, storageUsage: a.storage_usage };
    } catch (err) {
      if (err instanceof NearError && /UNKNOWN_ACCOUNT|does not exist/i.test(err.message)) return null;
      throw err;
    }
  }

  /** The access key's nonce, or null if the key is not on the account. */
  async accessKey(accountId: AccountId, publicKey: PublicKey): Promise<{ nonce: bigint; fullAccess: boolean } | null> {
    try {
      const k = await this.request<{ nonce: number; permission: unknown }>("query", { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey });
      return { nonce: BigInt(k.nonce), fullAccess: k.permission === "FullAccess" };
    } catch (err) {
      if (err instanceof NearError && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(err.message)) return null;
      throw err;
    }
  }

  async latestBlock(): Promise<{ hash: string; height: number; timestampMs: number }> {
    const b = await this.request<{ header: { hash: string; height: number; timestamp: number } }>("block", { finality: "optimistic" });
    return { hash: b.header.hash, height: b.header.height, timestampMs: Math.floor(b.header.timestamp / 1e6) };
  }

  /** A recent block hash for signing, cached for a few seconds. */
  async recentBlockHash(): Promise<Uint8Array> {
    if (this.block && Date.now() - this.block.at < 10_000) return this.block.hash;
    const b = await this.request<{ header: { hash: string } }>("block", { finality: "final" });
    this.block = { hash: base58.decode(b.header.hash), at: Date.now() };
    return this.block.hash;
  }

  /** One status lookup, no retries: callers poll. null while the node does not know the transaction yet. */
  async txStatus(hash: string, senderId: AccountId): Promise<RawOutcome | null> {
    try {
      return await this.request<RawOutcome>("tx", { tx_hash: hash, sender_account_id: senderId, wait_until: "EXECUTED_OPTIMISTIC" }, 1);
    } catch (err) {
      if (err instanceof NearError && /UNKNOWN_TRANSACTION|TIMEOUT/i.test(err.message)) return null;
      throw err;
    }
  }
}

interface RawOutcome {
  status?: { SuccessValue?: string; Failure?: unknown };
  final_execution_status?: string;
  transaction?: { hash: string };
  transaction_outcome?: { outcome: { gas_burnt: number; logs: string[] } };
  receipts_outcome?: { outcome: { logs: string[]; gas_burnt: number; status: { Failure?: unknown } } }[];
}

/** Dig the human-readable reason out of NEAR's nested failure object. */
export function failureReason(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /Smart contract panicked: ((?:[^"\\]|\\.)*)/.exec(text);
  if (panic) return panic[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const exec = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (exec) return exec[1]!;
  return text.length > 400 ? text.slice(0, 400) + "..." : text;
}

function toResult<T>(raw: RawOutcome, fallbackHash: string): TxResult<T> {
  const hash = raw.transaction?.hash ?? fallbackHash;
  if (raw.status?.Failure !== undefined) {
    const reason = failureReason(raw.status.Failure);
    throw new NearError(reason, "failure", reason);
  }
  const receipts = raw.receipts_outcome ?? [];
  const logs = [...(raw.transaction_outcome?.outcome.logs ?? []), ...receipts.flatMap((r) => r.outcome.logs)];
  const gasBurnt = BigInt(raw.transaction_outcome?.outcome.gas_burnt ?? 0) + receipts.reduce((g, r) => g + BigInt(r.outcome.gas_burnt), 0n);
  const receiptFailures = receipts.filter((r) => r.outcome.status.Failure !== undefined).map((r) => failureReason(r.outcome.status.Failure));
  let value: unknown = null;
  const b64 = raw.status?.SuccessValue;
  if (b64) {
    const text = new TextDecoder().decode(fromBase64(b64));
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { hash, value: value as T, logs, gasBurnt, receiptFailures };
}

/** An account that can sign. Sends are serialised, so its nonce never collides with itself. */
export class NearAccount {
  readonly rpc: NearRpc;
  readonly accountId: AccountId;
  readonly keyPair: KeyPair;
  private nonce: bigint | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rpc: NearRpc, accountId: AccountId, secretKey: string) {
    this.rpc = rpc;
    this.accountId = accountId;
    this.keyPair = keyPairFromSecret(secretKey);
  }

  get publicKey(): PublicKey {
    return this.keyPair.publicKey;
  }

  /** Sign and send a transaction, and wait until every receipt has executed. */
  send<T = unknown>(receiverId: AccountId, actions: Action[]): Promise<TxResult<T>> {
    const run = () => this.sendNow<T>(receiverId, actions);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async sendNow<T>(receiverId: AccountId, actions: Action[]): Promise<TxResult<T>> {
    for (let attempt = 0; ; attempt++) {
      if (this.nonce === null) {
        const k = await this.rpc.accessKey(this.accountId, this.publicKey);
        if (!k) throw new NearError(`${this.accountId} does not exist or does not hold key ${this.publicKey}`, "no-key");
        this.nonce = k.nonce;
      }
      this.nonce += 1n;
      const blockHash = await this.rpc.recentBlockHash();
      const tx = encodeTransaction({ signerId: this.accountId, publicKey: this.publicKey, nonce: this.nonce, receiverId, blockHash, actions });
      const txHash = sha256Bytes(tx);
      const signature = ed25519.sign(txHash, base58.decode(this.keyPair.secretKey.slice(8)).slice(0, 32));
      const signed = toBase64(concatBytes(tx, new Uint8Array([0]), signature));
      const hash = base58.encode(txHash);
      try {
        const raw = await this.sendSigned(signed);
        return toResult<T>(raw, hash);
      } catch (err) {
        if (err instanceof NearError && err.kind === "failure") throw err;
        const message = (err as Error).message;
        if (/InvalidNonce|nonce/i.test(message) && attempt < 3) {
          this.nonce = null; // another process used the key: read the nonce again
          continue;
        }
        if (/Expired|InvalidTransaction/i.test(message) && !/TIMEOUT/i.test(message)) throw err;
        // The node may have accepted the transaction before the connection dropped, or it is
        // still executing: ask for it by hash, but never for longer than a minute, so one lost
        // transaction cannot hold up every later one from this account.
        const deadline = Date.now() + TX_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1_000));
          const raw = await this.rpc.txStatus(hash, this.accountId).catch(() => null);
          if (raw?.status && (raw.status.SuccessValue !== undefined || raw.status.Failure !== undefined)) return toResult<T>(raw, hash);
        }
        this.nonce = null;
        throw new NearError(`transaction ${hash} did not finish within ${TX_WAIT_MS / 1000}s (${message})`, "timeout");
      }
    }
  }

  /**
   * Submit a signed transaction. A network error before the node answered (most often a
   * kept-alive connection the node had already closed) means the transaction may never have
   * arrived, so the identical bytes are sent again: the node identifies a transaction by its
   * hash, so a second copy can never execute twice.
   */
  private async sendSigned(signed: string): Promise<RawOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.rpc.request<RawOutcome>("send_tx", { signed_tx_base64: signed, wait_until: "EXECUTED_OPTIMISTIC" }, 1);
      } catch (err) {
        const network = !(err instanceof NearError) || err.kind === "rpc";
        if (!network || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  }

  call<T = unknown>(contract: AccountId, method: string, args: unknown = {}, opts: { gas?: bigint; deposit?: bigint } = {}): Promise<TxResult<T>> {
    return this.send<T>(contract, [functionCall(method, args, opts.gas ?? 30n * TGAS, opts.deposit ?? 0n)]);
  }

  view<T>(contract: AccountId, method: string, args: unknown = {}): Promise<T> {
    return this.rpc.view<T>(contract, method, args);
  }

  transfer(to: AccountId, yocto: bigint): Promise<TxResult> {
    return this.send(to, [{ type: "transfer", deposit: yocto }]);
  }

  /** Create `<name>.<this account>` with one full-access key and an opening balance. */
  createSubAccount(name: string, publicKey: PublicKey, yocto: bigint, extra: Action[] = []): Promise<TxResult> {
    return this.send(`${name}.${this.accountId}`, [{ type: "createAccount" }, { type: "transfer", deposit: yocto }, { type: "addFullAccessKey", publicKey }, ...extra]);
  }

  deploy(code: Uint8Array, init?: { method: string; args: unknown }): Promise<TxResult> {
    const actions: Action[] = [{ type: "deployContract", code }];
    if (init) actions.push(functionCall(init.method, init.args, 100n * TGAS));
    return this.send(this.accountId, actions);
  }
}
