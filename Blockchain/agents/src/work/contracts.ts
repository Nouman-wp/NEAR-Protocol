/**
 * Smart-contract work, done by code: a NEAR contract (near-sdk 5) written from one of three
 * templates, a unit-test module for it, and a static audit that reads the source and
 * reports what it finds with line numbers. No model is involved, and the audit is real:
 * it parses the methods and checks them, so it catches a missing access check whoever
 * wrote the code.
 */

export const TEMPLATES = ["escrow", "token", "voting"] as const;
export type Template = (typeof TEMPLATES)[number];

export interface ContractBrief {
  template?: Template;
  name: string;
  /** escrow: fee in basis points; token: supply cap; voting: period in minutes */
  param?: number;
}

export interface ContractCode {
  template: Template;
  crate: string;
  struct: string;
  files: { path: string; content: string }[];
  methods: string[];
  lines: number;
}

export interface Finding {
  rule: string;
  severity: "high" | "medium" | "low" | "info";
  line: number;
  method: string | null;
  message: string;
}

export interface Audit {
  findings: Finding[];
  score: number;
  pass: boolean;
  methods: number;
  checked: string[];
}

export function templateOf(brief: ContractBrief): Template {
  if (brief.template && (TEMPLATES as readonly string[]).includes(brief.template)) return brief.template;
  const n = brief.name.toLowerCase();
  if (/vote|dao|govern|council/.test(n)) return "voting";
  if (/token|point|coin|reward|credit/.test(n)) return "token";
  return "escrow";
}

const camel = (s: string) =>
  s
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join("") || "Contract";
const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contract";

const CARGO = (crate: string) => `[package]
name = "${crate}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
near-sdk = "5"

[dev-dependencies]
near-sdk = { version = "5", features = ["unit-testing"] }

[profile.release]
codegen-units = 1
opt-level = "z"
lto = true
panic = "abort"
overflow-checks = true
`;

function escrow(s: string, title: string, feeBps: number): string {
  return `//! ${title}: an escrow with an arbiter. The buyer locks NEAR for a seller; the buyer or
//! the arbiter releases it, the seller or the arbiter refunds it.
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum DealStatus {
    Funded,
    Released,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Deal {
    pub buyer: AccountId,
    pub seller: AccountId,
    pub arbiter: AccountId,
    pub amount: NearToken,
    pub status: DealStatus,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ${s} {
    owner: AccountId,
    fee_bps: u16,
    next_id: u64,
    deals: LookupMap<u64, Deal>,
}

#[near]
impl ${s} {
    #[init]
    pub fn new(owner: AccountId, fee_bps: u16) -> Self {
        require!(fee_bps <= 1_000, "the fee is capped at 10%");
        Self { owner, fee_bps, next_id: 0, deals: LookupMap::new(b"d") }
    }

    /// The buyer opens a deal by attaching the amount to hold in escrow (default fee ${feeBps} bps).
    #[payable]
    pub fn open(&mut self, seller: AccountId, arbiter: AccountId) -> u64 {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "attach the amount to hold in escrow");
        let buyer = env::predecessor_account_id();
        require!(buyer != seller, "buyer and seller must differ");
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).unwrap_or_else(|| env::panic_str("too many deals"));
        self.deals.insert(id, Deal { buyer, seller, arbiter, amount, status: DealStatus::Funded });
        id
    }

    /// The buyer or the arbiter pays the seller, minus the fee.
    pub fn release(&mut self, id: u64) -> Promise {
        let mut deal = self.funded(id);
        let caller = env::predecessor_account_id();
        require!(caller == deal.buyer || caller == deal.arbiter, "only the buyer or the arbiter can release");
        deal.status = DealStatus::Released;
        let fee = deal.amount.saturating_mul(self.fee_bps as u128).saturating_div(10_000);
        let payout = deal.amount.saturating_sub(fee);
        let seller = deal.seller.clone();
        self.deals.insert(id, deal);
        let pay = Promise::new(seller).transfer(payout);
        if fee.is_zero() {
            pay
        } else {
            pay.and(Promise::new(self.owner.clone()).transfer(fee))
        }
    }

    /// The seller or the arbiter returns the full amount to the buyer.
    pub fn refund(&mut self, id: u64) -> Promise {
        let mut deal = self.funded(id);
        let caller = env::predecessor_account_id();
        require!(caller == deal.seller || caller == deal.arbiter, "only the seller or the arbiter can refund");
        deal.status = DealStatus::Refunded;
        let (buyer, amount) = (deal.buyer.clone(), deal.amount);
        self.deals.insert(id, deal);
        Promise::new(buyer).transfer(amount)
    }

    pub fn get_deal(&self, id: u64) -> Option<Deal> {
        self.deals.get(&id).cloned()
    }

    fn funded(&self, id: u64) -> Deal {
        let deal = self.deals.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown deal"));
        require!(deal.status == DealStatus::Funded, "the deal is already settled");
        deal
    }
}
`;
}

function token(s: string, title: string, cap: number): string {
  return `//! ${title}: a capped points token. The owner mints up to the cap; holders transfer
//! with 1 yoctoNEAR attached, which proves a full-access key signed the call.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ${s} {
    owner: AccountId,
    cap: u128,
    total_supply: u128,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl ${s} {
    /// Suggested cap: ${cap}.
    #[init]
    pub fn new(owner: AccountId, cap: U128) -> Self {
        require!(cap.0 > 0, "the cap must be positive");
        Self { owner, cap: cap.0, total_supply: 0, balances: LookupMap::new(b"b") }
    }

    /// Owner only, never above the cap.
    pub fn mint(&mut self, to: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can mint");
        let supply = self.total_supply.checked_add(amount.0).unwrap_or_else(|| env::panic_str("supply overflow"));
        require!(supply <= self.cap, "minting would exceed the cap");
        self.total_supply = supply;
        let balance = self.balance(&to).checked_add(amount.0).unwrap_or_else(|| env::panic_str("balance overflow"));
        self.balances.insert(to, balance);
    }

    #[payable]
    pub fn transfer(&mut self, to: AccountId, amount: U128) {
        assert_one_yocto();
        let from = env::predecessor_account_id();
        require!(from != to, "cannot transfer to yourself");
        let have = self.balance(&from);
        let left = have.checked_sub(amount.0).unwrap_or_else(|| env::panic_str("balance too low"));
        let received = self.balance(&to).checked_add(amount.0).unwrap_or_else(|| env::panic_str("balance overflow"));
        self.balances.insert(from, left);
        self.balances.insert(to, received);
    }

    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    pub fn total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    fn balance(&self, account_id: &AccountId) -> u128 {
        self.balances.get(account_id).copied().unwrap_or(0)
    }
}
`;
}

function voting(s: string, title: string, periodMin: number): string {
  return `//! ${title}: member voting. The owner admits members; members propose and vote once
//! each before the deadline; anyone finalises after it.
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Proposal {
    pub title: String,
    pub yes: u32,
    pub no: u32,
    pub ends_at_ms: u64,
    pub finalized: bool,
    pub passed: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ${s} {
    owner: AccountId,
    period_ms: u64,
    quorum: u32,
    next_id: u64,
    members: LookupSet<AccountId>,
    proposals: LookupMap<u64, Proposal>,
    voted: LookupSet<(u64, AccountId)>,
}

#[near]
impl ${s} {
    /// Suggested voting period: ${periodMin} minutes.
    #[init]
    pub fn new(owner: AccountId, period_minutes: u64, quorum: u32) -> Self {
        require!(period_minutes > 0 && quorum > 0, "period and quorum must be positive");
        let period_ms = period_minutes.checked_mul(60_000).unwrap_or_else(|| env::panic_str("period too long"));
        Self { owner, period_ms, quorum, next_id: 0, members: LookupSet::new(b"m"), proposals: LookupMap::new(b"p"), voted: LookupSet::new(b"v") }
    }

    pub fn add_member(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can add members");
        self.members.insert(account_id);
    }

    pub fn propose(&mut self, title: String) -> u64 {
        require!(self.members.contains(&env::predecessor_account_id()), "only members can propose");
        require!(!title.is_empty() && title.len() <= 140, "the title must be 1 to 140 characters");
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).unwrap_or_else(|| env::panic_str("too many proposals"));
        let ends_at_ms = env::block_timestamp_ms().saturating_add(self.period_ms);
        self.proposals.insert(id, Proposal { title, yes: 0, no: 0, ends_at_ms, finalized: false, passed: false });
        id
    }

    pub fn vote(&mut self, id: u64, yes: bool) {
        let voter = env::predecessor_account_id();
        require!(self.members.contains(&voter), "only members can vote");
        let mut p = self.proposal(id);
        require!(env::block_timestamp_ms() < p.ends_at_ms, "voting has ended");
        require!(self.voted.insert((id, voter)), "already voted");
        if yes {
            p.yes = p.yes.checked_add(1).unwrap_or_else(|| env::panic_str("too many votes"));
        } else {
            p.no = p.no.checked_add(1).unwrap_or_else(|| env::panic_str("too many votes"));
        }
        self.proposals.insert(id, p);
    }

    pub fn finalize(&mut self, id: u64) -> bool {
        let mut p = self.proposal(id);
        require!(env::block_timestamp_ms() >= p.ends_at_ms, "voting is still open");
        require!(!p.finalized, "already finalized");
        let turnout = p.yes.saturating_add(p.no);
        p.passed = p.yes > p.no && turnout >= self.quorum;
        p.finalized = true;
        let passed = p.passed;
        self.proposals.insert(id, p);
        passed
    }

    pub fn get_proposal(&self, id: u64) -> Option<Proposal> {
        self.proposals.get(&id).cloned()
    }

    fn proposal(&self, id: u64) -> Proposal {
        self.proposals.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown proposal"))
    }
}
`;
}

export function writeContract(brief: ContractBrief): ContractCode {
  const template = templateOf(brief);
  const struct = camel(brief.name);
  const crate = kebab(brief.name);
  const title = brief.name.trim().slice(0, 60) || struct;
  const src =
    template === "escrow"
      ? escrow(struct, title, Math.min(1000, Math.max(0, Math.round(brief.param ?? 100))))
      : template === "token"
        ? token(struct, title, Math.max(1, Math.round(brief.param ?? 1_000_000)))
        : voting(struct, title, Math.max(1, Math.round(brief.param ?? 60)));
  // the tester delivers src/tests.rs; a normal build skips it
  const lib = `${src.trimEnd()}\n\n#[cfg(test)]\nmod tests;\n`;
  return {
    template,
    crate,
    struct,
    files: [
      { path: "Cargo.toml", content: CARGO(crate) },
      { path: "src/lib.rs", content: lib },
    ],
    methods: parseMethods(src).filter((m) => m.pub).map((m) => m.name),
    lines: lib.split("\n").length,
  };
}

/**
 * Deliberately sloppy work (the budget coder, some of the time): the same contract with
 * its most important access check removed. The audit is there to catch exactly this.
 */
export function sloppy(code: ContractCode): ContractCode {
  const lib = code.files.find((f) => f.path === "src/lib.rs")!;
  const content = lib.content
    .split("\n")
    .filter((l) => !/require!\((caller ==|env::predecessor_account_id\(\) == self\.owner)/.test(l))
    .join("\n");
  return { ...code, files: code.files.map((f) => (f === lib ? { ...f, content } : f)), lines: content.split("\n").length };
}

// ------------------------------------------------------------------ tests

const SUITES: Record<Template, (s: string) => { name: string; body: string; panics?: string }[]> = {
  escrow: (s) => [
    { name: "open_holds_the_deposit", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 100);\n        ctx(1, 1_000); let id = c.open(accounts(2), accounts(3));\n        let d = c.get_deal(id).unwrap();\n        assert_eq!(d.amount, NearToken::from_yoctonear(1_000));\n        assert!(d.status == DealStatus::Funded);` },
    { name: "open_needs_a_deposit", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 100);\n        ctx(1, 0); c.open(accounts(2), accounts(3));`, panics: "attach the amount to hold in escrow" },
    { name: "the_buyer_releases_to_the_seller", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 100);\n        ctx(1, 1_000); let id = c.open(accounts(2), accounts(3));\n        ctx(1, 0); c.release(id);\n        assert!(c.get_deal(id).unwrap().status == DealStatus::Released);` },
    { name: "a_stranger_cannot_release", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 100);\n        ctx(1, 1_000); let id = c.open(accounts(2), accounts(3));\n        ctx(4, 0); c.release(id);`, panics: "only the buyer or the arbiter can release" },
    { name: "a_stranger_cannot_refund", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 100);\n        ctx(1, 1_000); let id = c.open(accounts(2), accounts(3));\n        ctx(4, 0); c.refund(id);`, panics: "only the seller or the arbiter can refund" },
    { name: "a_deal_settles_once", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 100);\n        ctx(1, 1_000); let id = c.open(accounts(2), accounts(3));\n        ctx(1, 0); c.release(id);\n        ctx(3, 0); c.refund(id);`, panics: "the deal is already settled" },
  ],
  token: (s) => [
    { name: "the_owner_mints_up_to_the_cap", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), U128(100));\n        c.mint(accounts(1), U128(100));\n        assert_eq!(c.total_supply().0, 100);\n        assert_eq!(c.balance_of(accounts(1)).0, 100);` },
    { name: "minting_past_the_cap_fails", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), U128(100));\n        c.mint(accounts(1), U128(101));`, panics: "minting would exceed the cap" },
    { name: "only_the_owner_mints", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), U128(100));\n        ctx(1, 0); c.mint(accounts(1), U128(1));`, panics: "only the owner can mint" },
    { name: "transfer_moves_points", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), U128(100));\n        c.mint(accounts(1), U128(60));\n        ctx(1, 1); c.transfer(accounts(2), U128(25));\n        assert_eq!(c.balance_of(accounts(1)).0, 35);\n        assert_eq!(c.balance_of(accounts(2)).0, 25);` },
    { name: "transfer_needs_enough_balance", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), U128(100));\n        c.mint(accounts(1), U128(10));\n        ctx(1, 1); c.transfer(accounts(2), U128(11));`, panics: "balance too low" },
  ],
  voting: (s) => [
    { name: "members_propose_and_vote", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 10, 1);\n        c.add_member(accounts(1));\n        ctx(1, 0); let id = c.propose("Fund the grants round".into());\n        c.vote(id, true);\n        assert_eq!(c.get_proposal(id).unwrap().yes, 1);` },
    { name: "only_the_owner_adds_members", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 10, 1);\n        ctx(1, 0); c.add_member(accounts(2));`, panics: "only the owner can add members" },
    { name: "outsiders_cannot_vote", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 10, 1);\n        c.add_member(accounts(1));\n        ctx(1, 0); let id = c.propose("A".into());\n        ctx(2, 0); c.vote(id, true);`, panics: "only members can vote" },
    { name: "a_member_votes_once", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 10, 1);\n        c.add_member(accounts(1));\n        ctx(1, 0); let id = c.propose("A".into());\n        c.vote(id, true); c.vote(id, false);`, panics: "already voted" },
    { name: "finalize_waits_for_the_deadline", body: `ctx(0, 0); let mut c = ${s}::new(accounts(0), 10, 1);\n        c.add_member(accounts(1));\n        ctx(1, 0); let id = c.propose("A".into());\n        c.finalize(id);`, panics: "voting is still open" },
  ],
};

export interface TestSuite {
  path: string;
  content: string;
  cases: string[];
  guards: { message: string; covered: boolean }[];
}

/** A test module for the contract: the template's suite, plus a coverage report of its require! guards. */
export function writeTests(code: ContractCode): TestSuite {
  const lib = code.files.find((f) => f.path === "src/lib.rs")?.content ?? "";
  const cases = SUITES[code.template](code.struct);
  const guards = [...lib.matchAll(/require!\([^"]*"([^"]+)"\)/g)].map((m) => m[1]!);
  const covered = new Set(cases.map((c) => c.panics).filter(Boolean));
  const extraUse = code.template === "token" ? "use near_sdk::json_types::U128;\n" : "";
  // the module body itself: lib.rs declares `mod tests;`, so `use super::*` reaches the contract
  const content = `//! Unit tests for ${code.struct}. lib.rs declares this module; run them with \`cargo test\`.
use super::*;
${extraUse}use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

fn ctx(predecessor: usize, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(accounts(predecessor)).attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}
${cases
  .map(
    (c) => `
#[test]${c.panics ? `\n#[should_panic(expected = "${c.panics}")]` : ""}
fn ${c.name}() {
    ${c.body.replace(/\n {8}/g, "\n    ")}
}`,
  )
  .join("\n")}
`;
  return { path: "src/tests.rs", content, cases: cases.map((c) => c.name), guards: guards.map((g) => ({ message: g, covered: covered.has(g) })) };
}

// ------------------------------------------------------------------ audit

interface Method {
  name: string;
  pub: boolean;
  line: number;
  attrs: string[];
  mutable: boolean;
  body: string;
  bodyStart: number;
}

/** Every fn with its attributes and body, by brace counting. */
export function parseMethods(src: string): Method[] {
  const lines = src.split("\n");
  const out: Method[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*(pub\s+)?fn\s+([a-z_0-9]+)\s*\(([^)]*)/);
    if (!m) continue;
    const attrs: string[] = [];
    for (let j = i - 1; j >= 0 && /^\s*(#\[|\/\/\/)/.test(lines[j]!); j--) if (lines[j]!.trim().startsWith("#[")) attrs.push(lines[j]!.trim());
    let depth = 0;
    let started = false;
    const body: string[] = [];
    for (let k = i; k < lines.length; k++) {
      const l = lines[k]!;
      for (const ch of l) {
        if (ch === "{") (depth++, (started = true));
        else if (ch === "}") depth--;
      }
      body.push(l);
      if (started && depth <= 0) break;
    }
    out.push({ name: m[2]!, pub: !!m[1], line: i + 1, attrs, mutable: /&mut self/.test(m[3]!), body: body.join("\n"), bodyStart: i + 1 });
  }
  return out;
}

const PRIVILEGED = /^(mint|burn|set_|pause|unpause|add_member|remove_|upgrade|withdraw_fees|migrate)/;
const MONEY = /\b(amount|balance|supply|fee|payout|total|price|deposit)\w*\b/;

export function audit(src: string): Audit {
  const findings: Finding[] = [];
  const methods = parseMethods(src);
  const lines = src.split("\n");
  const add = (f: Finding) => findings.push(f);

  for (const m of methods) {
    const payable = m.attrs.some((a) => a.includes("payable"));
    const isPrivate = m.attrs.some((a) => a.includes("private"));
    const isInit = m.attrs.some((a) => a.includes("init"));
    const checksCaller = /predecessor_account_id\(\)/.test(m.body);
    if (payable && !/attached_deposit\(\)|assert_one_yocto\(\)/.test(m.body)) {
      add({ rule: "payable-ignores-deposit", severity: "high", line: m.line, method: m.name, message: `${m.name} is #[payable] but never reads the attached deposit, so NEAR sent to it is kept without being accounted for` });
    }
    if (m.pub && m.mutable && !isInit && /Promise::new\([^)]*\)\s*\.transfer\(|\.transfer\(/.test(m.body) && !/caller|predecessor_account_id/.test(m.body)) {
      add({ rule: "unguarded-transfer", severity: "high", line: m.line, method: m.name, message: `${m.name} sends NEAR without checking who is calling` });
    }
    if (m.pub && m.mutable && !isInit && /\.transfer\(/.test(m.body) && /caller/.test(m.body) && !/require!\(\s*caller/.test(m.body)) {
      add({ rule: "caller-read-not-enforced", severity: "high", line: m.line, method: m.name, message: `${m.name} reads the caller but never requires anything of it before moving funds` });
    }
    if (m.pub && m.mutable && PRIVILEGED.test(m.name) && !checksCaller) {
      add({ rule: "missing-access-check", severity: "high", line: m.line, method: m.name, message: `${m.name} is a privileged method with no check on the caller` });
    }
    if ((/^on_|_callback$/.test(m.name) || /callback_result|callback_unwrap/.test(m.attrs.join(" "))) && !isPrivate) {
      add({ rule: "public-callback", severity: "high", line: m.line, method: m.name, message: `${m.name} looks like a callback but is not #[private]: anyone can call it` });
    }
  }

  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, "");
    if (/\.unwrap\(\)/.test(code)) add({ rule: "bare-unwrap", severity: "low", line: i + 1, method: methodAt(methods, i + 1), message: "unwrap() panics with no message; use unwrap_or_else(|| env::panic_str(...))" });
    if (MONEY.test(code) && /[^=!<>]\s[+\-*]\s|[+\-*]=/.test(code) && !/checked_|saturating_|\/\/|"|^\s*(use|\/\/)/.test(code)) {
      add({ rule: "unchecked-arithmetic", severity: "medium", line: i + 1, method: methodAt(methods, i + 1), message: "arithmetic on a balance without checked_ or saturating_ (overflow-checks are on in release, but the panic has no message)" });
    }
    if (/block_timestamp/.test(code)) add({ rule: "timestamp", severity: "info", line: i + 1, method: methodAt(methods, i + 1), message: "block time is set by validators to within a second or so; fine for deadlines measured in minutes" });
  });

  const state = src.match(/#\[near\(contract_state\)\]\s*\n\s*(#\[derive\(([^)]*)\)\])?/);
  if (state && !/PanicOnDefault/.test(state[2] ?? "")) add({ rule: "default-state", severity: "medium", line: lineOf(src, "#[near(contract_state)]"), method: null, message: "contract state without PanicOnDefault can be used before #[init] runs" });

  const prefixes = [...src.matchAll(/::new\(b"([^"]*)"\)/g)].map((m) => m[1]!);
  const dup = prefixes.find((p, i) => prefixes.indexOf(p) !== i);
  if (dup !== undefined) add({ rule: "storage-prefix-collision", severity: "high", line: lineOf(src, `b"${dup}"`), method: null, message: `two collections share the storage prefix b"${dup}" and will overwrite each other` });

  const weight = { high: 30, medium: 8, low: 3, info: 0 };
  const score = Math.max(0, 100 - findings.reduce((a, f) => a + weight[f.severity], 0));
  return {
    findings: findings.sort((a, b) => ["high", "medium", "low", "info"].indexOf(a.severity) - ["high", "medium", "low", "info"].indexOf(b.severity) || a.line - b.line),
    score,
    pass: !findings.some((f) => f.severity === "high"),
    methods: methods.length,
    checked: ["payable-ignores-deposit", "unguarded-transfer", "caller-read-not-enforced", "missing-access-check", "public-callback", "bare-unwrap", "unchecked-arithmetic", "timestamp", "default-state", "storage-prefix-collision"],
  };
}

function methodAt(methods: Method[], line: number): string | null {
  let best: Method | null = null;
  for (const m of methods) if (m.line <= line && line < m.line + m.body.split("\n").length) best = m;
  return best?.name ?? null;
}

function lineOf(src: string, needle: string): number {
  const i = src.indexOf(needle);
  return i < 0 ? 0 : src.slice(0, i).split("\n").length;
}
