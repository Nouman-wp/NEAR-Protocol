import { useSyncExternalStore } from "react";
import { AUTH_RECIPIENT, NearRpc, loginMessage, messageText, nep413Hash, randomBytes, randomKeyPair, sha256Bytes, signHash, toBase64, type IntentMandate } from "@quorum/core";
import { API, FLEET, api } from "./api.ts";

/**
 * The signed-in account. Sign-in is a NEP-413 message signed by a NEAR wallet (or, on the
 * local sandbox only, by a key this browser generated): the backend checks the signature
 * and the key on chain, then issues a session token. The same signer later authorises an
 * agent's spending by signing its intent.
 */

export interface Session {
  token: string;
  accountId: string;
  /** the key that signed in; intents name it as the operator key */
  publicKey: string;
  expiresAt: number;
  via: "wallet" | "dev";
  created?: boolean;
}

interface State {
  session: Session | null;
  /** an account connected in the wallet that has not signed in yet */
  connected: string | null;
  busy: string | null;
  error: string | null;
}

const SESSION_KEY = "quorum-session";
const DEV_KEY = "quorum-dev-wallet";
const listeners = new Set<() => void>();

const read = <T>(key: string): T | null => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const write = (key: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // private mode: the session lasts for this page only
  }
};

let state: State = { session: (() => {
  const s = read<Session>(SESSION_KEY);
  return s && s.expiresAt > Date.now() ? s : null;
})(), connected: null, busy: null, error: null };

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if ("session" in patch) write(SESSION_KEY, patch.session ?? null);
  listeners.forEach((l) => l());
}

export function useAccount(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

// ------------------------------------------------------------------ network

interface NetInfo {
  key: string;
  name: string;
  rpc: string;
  contract: string;
}
let netP: Promise<NetInfo> | null = null;
export function network(): Promise<NetInfo> {
  netP ??= api<{ network: { key: string; name: string; rpc: string }; deployment: { contract: string } }>("/v1/config").then((c) => ({ key: c.network.key, name: c.network.name, rpc: c.network.rpc, contract: c.deployment.contract }));
  return netP;
}

export const walletsSupported = (key: string) => key === "testnet" || key === "mainnet";

// ------------------------------------------------------------------ the wallet (loaded only when used)

type Kit = { selector: import("@near-wallet-selector/core").WalletSelector; modal: { show: () => void; hide: () => void } };
let kitP: Promise<Kit> | null = null;

async function walletKit(): Promise<Kit> {
  kitP ??= (async () => {
    const net = await network();
    if (!walletsSupported(net.key)) throw new Error("NEAR wallets work on testnet and mainnet. On the local sandbox, use the dev wallet.");
    // the wallet libraries expect a few Node globals in the browser
    const g = globalThis as { Buffer?: unknown; global?: unknown; process?: unknown };
    g.global ??= globalThis;
    g.process ??= { env: {}, browser: true, version: "" };
    const { Buffer } = await import("buffer");
    g.Buffer ??= Buffer;
    const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }, { setupHereWallet }] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/modal-ui"),
      import("@near-wallet-selector/my-near-wallet"),
      import("@near-wallet-selector/meteor-wallet"),
      import("@near-wallet-selector/here-wallet"),
    ]);
    await import("@near-wallet-selector/modal-ui/styles.css");
    const selector = await setupWalletSelector({ network: net.key as "testnet" | "mainnet", modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet()] });
    const modal = setupModal(selector, { theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", description: "Connect a NEAR wallet, then sign one short message to prove the account is yours. No transaction, no fee." });
    selector.store.observable.subscribe((s) => {
      const acc = s.accounts.find((a) => a.active)?.accountId ?? s.accounts[0]?.accountId ?? null;
      if (acc !== state.connected) set({ connected: acc });
    });
    return { selector, modal };
  })();
  kitP.catch(() => (kitP = null));
  return kitP;
}

/** Show the wallet picker. Sign-in itself is a second click (wallets open popups only from a click). */
export async function connectWallet(): Promise<void> {
  set({ error: null });
  try {
    const kit = await walletKit();
    kit.modal.show();
  } catch (err) {
    set({ error: (err as Error).message });
  }
}

/** Reconnect a wallet the browser already knows, without a popup. */
export async function restoreWallet(): Promise<void> {
  const net = await network().catch(() => null);
  if (!net || !walletsSupported(net.key)) return;
  try {
    const raw = localStorage.getItem("near-wallet-selector:selectedWalletId");
    if (raw) await walletKit();
  } catch {
    // nothing to restore
  }
}

interface Signed {
  accountId: string;
  publicKey: string;
  signature: string;
  callbackUrl?: string;
}

/** Sign a NEP-413 payload with whatever this account signs with. */
async function sign(message: string, recipient: string, nonce: Uint8Array, via: Session["via"]): Promise<Signed> {
  if (via === "dev") {
    const dev = read<{ accountId: string; publicKey: string; secretKey: string }>(DEV_KEY);
    if (!dev) throw new Error("this browser's dev wallet is gone; create a new one");
    return { accountId: dev.accountId, publicKey: dev.publicKey, signature: signHash(nep413Hash(message, recipient, nonce), dev.secretKey) };
  }
  const kit = await walletKit();
  const wallet = await kit.selector.wallet();
  if (!("signMessage" in wallet) || !wallet.signMessage) throw new Error(`${wallet.metadata.name} cannot sign messages; try MyNearWallet or Meteor`);
  const callbackUrl = `${window.location.origin}/dashboard`;
  const { Buffer } = await import("buffer");
  const r = await wallet.signMessage({ message, recipient, nonce: Buffer.from(nonce), callbackUrl });
  if (!r || !r.signature) throw new Error("the wallet did not return a signature");
  return { accountId: r.accountId, publicKey: r.publicKey, signature: r.signature, callbackUrl };
}

async function login(accountId: string, via: Session["via"]): Promise<void> {
  const net = await network();
  const message = loginMessage(accountId, net.key, Date.now());
  const nonce = randomBytes(32);
  const s = await sign(message, AUTH_RECIPIENT, nonce, via);
  const r = await api<{ token: string; expiresAt: number; created: boolean }>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ accountId: s.accountId || accountId, message, recipient: AUTH_RECIPIENT, nonce: toBase64(nonce), callbackUrl: s.callbackUrl, publicKey: s.publicKey, signature: s.signature }),
  });
  set({ session: { token: r.token, accountId: s.accountId || accountId, publicKey: s.publicKey, expiresAt: r.expiresAt, via, created: r.created }, error: null });
}

async function busy<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  set({ busy: what, error: null });
  try {
    return await fn();
  } catch (err) {
    set({ error: (err as Error).message });
    return undefined;
  } finally {
    set({ busy: null });
  }
}

export const signInWithWallet = () =>
  busy("Waiting for your wallet to sign…", async () => {
    if (!state.connected) throw new Error("connect a wallet first");
    await login(state.connected, "wallet");
  });

/** Local sandbox: a key generated in this browser, and an account for it on the sandbox. */
export const signInWithDevWallet = () =>
  busy("Creating a dev account on the sandbox…", async () => {
    let dev = read<{ accountId: string; publicKey: string; secretKey: string }>(DEV_KEY);
    // a restarted sandbox no longer has the account an earlier run made for this browser
    if (dev && !(await new NearRpc((await network()).rpc).account(dev.accountId).catch(() => null))) dev = null;
    if (!dev) {
      const key = randomKeyPair();
      const r = await authed<{ accountId: string }>("fleet", "/users/dev-account", { method: "POST", body: JSON.stringify({ publicKey: key.publicKey }) }, false);
      dev = { accountId: r.accountId, publicKey: key.publicKey, secretKey: key.secretKey };
      write(DEV_KEY, dev);
    }
    await login(dev.accountId, "dev");
  });

export async function signOut(): Promise<void> {
  const via = state.session?.via;
  set({ session: null, error: null });
  if (via === "wallet") {
    try {
      const kit = await walletKit();
      const w = await kit.selector.wallet();
      await w.signOut();
    } catch {
      // already disconnected
    }
    set({ connected: null });
  }
}

// ------------------------------------------------------------------ authorised calls

export async function authed<T>(base: "api" | "fleet", path: string, init: RequestInit = {}, withToken = true): Promise<T> {
  const token = state.session?.token;
  const res = await fetch(`${base === "api" ? API : FLEET}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(withToken && token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (res.status === 401 && withToken) set({ session: null });
  if (!res.ok) throw new Error((json as { error?: string })?.error ?? `HTTP ${res.status}`);
  return json as T;
}

const jsonBig = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * The operator authorises an agent's spending: an AP2-style intent signed by the account
 * that operates the agent, checked by the clearing service against the key on chain.
 */
export const authoriseSpending = (agentId: string, budgetUsd: number, perJobUsd: number, days: number) =>
  busy("Waiting for your wallet to sign the spending limit…", async () => {
    const s = state.session;
    if (!s) throw new Error("sign in first");
    const net = await network();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const intent: IntentMandate = {
      operator: s.accountId,
      operatorKey: s.publicKey,
      buyer: BigInt(agentId),
      goal: `Commission work from the Quorum dashboard, authorised by ${s.accountId}`,
      budget: BigInt(Math.round(budgetUsd * 1e6)),
      perJobCap: BigInt(Math.round(perJobUsd * 1e6)),
      minSellerReputation: 0,
      allowedServices: [],
      allowedSellers: [],
      notBefore: now - 60n,
      deadline: now + BigInt(Math.round(days * 86_400)),
      nonce: BigInt(Date.now()),
    };
    const message = messageText("IntentMandate", intent);
    const signed = await sign(message, net.contract, sha256Bytes(message), s.via);
    if (signed.publicKey !== s.publicKey) throw new Error(`your wallet signed with ${signed.publicKey}, not the key you signed in with; sign out and in again`);
    return authed("api", "/v1/intents", { method: "POST", body: jsonBig({ intent, signature: signed.signature, callbackUrl: signed.callbackUrl }) }, false);
  });
