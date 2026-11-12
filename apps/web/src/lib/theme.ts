import { useSyncExternalStore } from "react";

/** Light is the default; the choice is remembered per browser. index.html applies it before first paint. */
export type Theme = "light" | "dark";
const KEY = "quorum-theme";
const listeners = new Set<() => void>();

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#12060a" : "#e9e2d5");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // private mode: the choice lasts for this page only
  }
  listeners.forEach((l) => l());
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentTheme,
    () => "light" as Theme,
  );
  return [theme, () => setTheme(theme === "dark" ? "light" : "dark")];
}
