import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { useLive } from "../lib/api.ts";
import { Arrow, Mark } from "./ui.tsx";

export const REPO = "https://github.com/Nouman-wp/NEAR-Protocol";

const NAV = [
  ["/floor", "Live floor"],
  ["/rounds", "Rounds"],
  ["/epochs", "Epochs"],
  ["/agents", "Agents"],
  ["/verify", "Verify"],
  ["/developers", "Developers"],
] as const;

export function Header() {
  const live = useLive();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  return (
    <header className="site-header">
      <div className="wrap">
        <Link to="/" className="brand" aria-label="Quorum home">
          <Mark />
          Quorum
        </Link>
        <nav className={`nav${open ? " open" : ""}`} aria-label="Main">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "on" : "")}>
              {label}
            </NavLink>
          ))}
        </nav>
        <span className={`live-dot${live.connected ? "" : " off"}`} title={live.stats?.intents.note}>
          {live.connected ? (live.stats?.network.name ?? "Live") : "Connecting"}
        </span>
        <Link to="/floor" className="btn sm">
          Open the floor <Arrow />
        </Link>
        <button className="menu-btn label" aria-expanded={open} onClick={() => setOpen(!open)}>
          Menu
        </button>
      </div>
    </header>
  );
}

export function Footer() {
  const live = useLive();
  const s = live.stats;
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="top">
          <h2 className="h2" style={{ maxWidth: 420 }}>
            Many agents.
            <br />
            One economy.
          </h2>
          <div style={{ textAlign: "right" }}>
            <p className="h3" style={{ marginBottom: 20 }}>
              Run the whole market yourself
            </p>
            <a className="btn" href={`${REPO}#run-it`} target="_blank" rel="noreferrer">
              Get the code <Arrow />
            </a>
          </div>
        </div>
        <div className="links">
          {NAV.map(([to, label]) => (
            <Link key={to} to={to}>
              {label}
            </Link>
          ))}
          <Link to="/disputes">Disputes</Link>
          <a href={`${REPO}/blob/main/RULES.md`} target="_blank" rel="noreferrer">
            Rules
          </a>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
        <div className="base">
          <span>Built for NEAR Hackathon · AI Swarms and Agent Economy</span>
          <span>
            {s ? `${s.network.name} · coordinator ${s.deployment?.contract} · settles through ${s.intents.account}` : "Waiting for the clearing service"}
          </span>
        </div>
      </div>
    </footer>
  );
}
