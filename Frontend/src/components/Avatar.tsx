import type { ReactNode } from "react";

/** A stable colour per agent from the brand's range: burgundy through blush to sage. */
export function hue(id: string | number): string {
  // mid tones that read on both the off-white and the burgundy ground
  const palette = ["#c8707f", "#8c2c40", "#7b836e", "#b8956a", "#a35d6c", "#5e6852", "#d9a8b1", "#9aa58a"];
  return palette[Number(id) % palette.length]!;
}

/** Simple line icons (24×24, stroke only), one per kind of work. */
const ICONS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  check: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  shield: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z" />,
  lead: (
    <>
      <path d="M4 17h16M5 17l-1-9 5 4 3-6 3 6 5-4-1 9" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3h9l3 3v15H6Z" />
      <path d="M9 10h6M9 14h6M9 18h4" />
    </>
  ),
  chart: <path d="M4 20h16M7 20v-6M12 20V8M17 20v-9" />,
  chip: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  bag: (
    <>
      <path d="M5 8h14l-1 12H6Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.5-4-8-9-8Z" />
      <circle cx="8" cy="11" r="1" />
      <circle cx="11" cy="7.5" r="1" />
      <circle cx="15.5" cy="8" r="1" />
    </>
  ),
  type: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  pen: (
    <>
      <path d="m4 20 3-1 11-11-2-2L5 17Z" />
      <path d="m14 6 2 2" />
    </>
  ),
  code: <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />,
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  spark: <path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" />,
  film: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="m10 9 5 3-5 3Z" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="9" r="3" />
      <circle cx="16.5" cy="10" r="2.5" />
      <path d="M3.5 19c.5-3 3-5 5.5-5s5 2 5.5 5M14 15c2.5 0 5 1.5 5.5 4" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" />,
};

/** Which icon a role gets. Roles come from the agents' own listings. */
export function roleIcon(role: string | null | undefined): keyof typeof ICONS {
  const r = (role ?? "").toLowerCase();
  if (r.startsWith("team lead")) return "team";
  if (r.includes("research lead")) return "lead";
  if (r.includes("security") || r.includes("auditor")) return "shield";
  if (r.includes("fact") || r.includes("validator")) return "check";
  if (r.includes("search")) return "search";
  if (r.includes("translat")) return "globe";
  if (r.includes("summar")) return "doc";
  if (r.includes("chart")) return "chart";
  if (r.includes("gpu")) return "chip";
  if (r.includes("buyer") || r.includes("client") || r.includes("user")) return "bag";
  if (r.includes("colour") || r.includes("color")) return "palette";
  if (r.includes("typograph")) return "type";
  if (r.includes("illustrat")) return "pen";
  if (r.includes("developer") || r.includes("rust")) return "code";
  if (r.includes("photo") || r.includes("retouch")) return "camera";
  if (r.includes("copywriter") || r.includes("ai ")) return "spark";
  if (r.includes("video")) return "film";
  return "dot";
}

/** A round avatar in the agent's colour with an icon for what it does. */
export function Avatar({ id, role, size = 20, title }: { id: string | number; role?: string | null; size?: number; title?: string }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: hue(id) }} title={title} aria-hidden={title ? undefined : true}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size < 24 ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round">
        {ICONS[roleIcon(role)]}
      </svg>
    </span>
  );
}
