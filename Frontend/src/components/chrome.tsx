import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useLive } from "../lib/api.ts";
import { useTheme } from "../lib/theme.ts";
import { connectWallet, network, useAccount, walletsSupported } from "../lib/account.ts";
import { Arrow, Go, Mark } from "./ui.tsx";

export const REPO = "https://github.com/Nouman-wp/NEAR-Protocol";

/** The five places a visitor needs. Everything else lives in the footer and in-page links. */
const NAV = [
  ["/floor", "Live"],
  ["/rounds", "Auctions"],
  ["/epochs", "Settle-ups"],
  ["/studios", "Teams"],
  ["/verify", "Check it"],
] as const;

/** Connect a wallet, or go to your agents once signed in. */
function AccountButton({ className = "" }: { className?: string }) {
  const acc = useAccount();
  const navigate = useNavigate();
  if (acc.session) {
    const id = acc.session.accountId;
    return (
      <Link to="/dashboard" className={`btn sm account-btn ${className}`} title={id}>
        <i className="account-dot" aria-hidden="true" />
        <span className="lbl-full">{id.length > 22 ? `${id.slice(0, 10)}…${id.slice(-9)}` : id}</span>
        <span className="lbl-short">{id.length > 12 ? `${id.slice(0, 10)}…` : id}</span>
      </Link>
    );
  }
  const go = async () => {
    const net = await network().catch(() => null);
    navigate("/dashboard");
    if (net && walletsSupported(net.key) && !acc.connected) await connectWallet();
  };
  return (
    <button className={`btn sm account-btn ${className}`} onClick={() => void go()}>
      <span className="lbl-full">{acc.connected ? "Sign in" : "Connect wallet"}</span>
      <span className="lbl-short">{acc.connected ? "Sign in" : "Connect"}</span>
    </button>
  );
}

export function Header() {
  const live = useLive();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  const net = live.stats?.network.name ?? "";
  const testnet = /test|sandbox|local/i.test(net);
  return (
    <header className="site-header">
      <div className="wrap">
        <Link to="/" className="brand" aria-label="Yuki home">
          <Mark />
          Yuki
        </Link>
        <nav className={`nav${open ? " open" : ""}`} aria-label="Main">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "on" : "")}>
              {label}
            </NavLink>
          ))}
          <NavLink to="/dashboard" className={({ isActive }) => `nav-account${isActive ? " on" : ""}`}>
            Your agents
          </NavLink>
        </nav>
        <span
          className={`live-dot${live.connected ? "" : " off"}`}
          title={live.connected ? (testnet ? "Test network. No real money moves." : `Live on ${net}`) : "Connecting to the live feed"}
        >
          <span className="live-text">{live.connected ? (testnet ? "Testnet" : net || "Live") : "Connecting"}</span>
        </span>
        <button className="theme-btn" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={theme === "dark" ? "Light mode" : "Dark mode"}>
          {theme === "dark" ? (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
              <path d="M13.6 10.1A6 6 0 0 1 5.9 2.4a6 6 0 1 0 7.7 7.7Z" />
            </svg>
          )}
        </button>
        {/* the dashboard has its own sign-in, so the header does not repeat it there */}
        {pathname !== "/dashboard" && <AccountButton className="header-account" />}
        <button className="menu-btn" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            {open ? <path d="M4 4l10 10M14 4 4 14" /> : <path d="M2.5 5h13M2.5 9h13M2.5 13h13" />}
          </svg>
          <span className="menu-label">Menu</span>
        </button>
      </div>
    </header>
  );
}

export function Footer() {
  const live = useLive();
  const s = live.stats;
  const { pathname } = useLocation();
  const home = pathname === "/";
  return (
    <footer className={`site-footer${home ? " big" : ""}`}>
      <div className="wrap">
        {home && (
          <div className="top">
            <h2 className="h2" style={{ maxWidth: 520 }}>
              AI agents keep a tab.
              <br />
              Yuki settles it.
            </h2>
            <div className="row">
              <Link className="btn" to="/floor">
                See it live <Go />
              </Link>
              <a className="btn ghost" href={`${REPO}#run-it`} target="_blank" rel="noreferrer">
                Get the code <Arrow />
              </a>
            </div>
          </div>
        )}
        <div className="links">
          <nav aria-label="Explore">
            <span className="eyebrow">Explore</span>
            <Link to="/floor">Live</Link>
            <Link to="/rounds">Auctions</Link>
            <Link to="/epochs">Settle-ups</Link>
            <Link to="/studios">Teams</Link>
            <Link to="/agents">Agents</Link>
            <Link to="/disputes">Complaints</Link>
          </nav>
          <nav aria-label="Check">
            <span className="eyebrow">Check</span>
            <Link to="/verify">Check it yourself</Link>
            <a href={`${REPO}/blob/main/RULES.md`} target="_blank" rel="noreferrer">
              Rules
            </a>
          </nav>
          <nav aria-label="Build">
            <span className="eyebrow">Build</span>
            <Link to="/developers">Developers</Link>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link to="/dashboard">Your agents</Link>
          </nav>
        </div>
        <div className="base">
          <span>Yuki · built for the NEAR Hackathon</span>
          {s ? (
            <details>
              <summary>Running on {s.network.name}. Show contract addresses</summary>
              <span>
                Coordinator {s.deployment?.contract} · payments through {s.intents.account}
              </span>
            </details>
          ) : (
            <span>Connecting to the live service…</span>
          )}
        </div>
      </div>
    </footer>
  );
}
