"use client";

import { useSyncExternalStore } from "react";
import { THEME_KEY } from "@/lib/theme";

// The saved choice is applied to <html data-theme> before first paint by the inline script in app/layout.tsx.
type Theme = "system" | "light" | "dark";

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
// <html data-theme> is the source of truth, so the switch is right even when browser storage is blocked.
const current = (): Theme => {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
};

function setTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the choice still applies until the page is reloaded.
  }
  listeners.forEach((fn) => fn());
}

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "Match browser", icon: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></> },
  { value: "light", label: "Light", icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> },
  { value: "dark", label: "Dark", icon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /> },
];

export default function ThemeSwitch() {
  // The server (and the first client render) always assume "system"; React then switches to the real value.
  const theme = useSyncExternalStore(subscribe, current, () => "system" as Theme);
  return (
    <fieldset className="flex rounded-xl border border-line-strong bg-surface p-0.5">
      <legend className="sr-only">Color theme</legend>
      {OPTIONS.map((o) => (
        <span key={o.value} className="relative flex">
          <input
            id={`theme-${o.value}`}
            type="radio"
            name="color-theme"
            value={o.value}
            checked={theme === o.value}
            onChange={() => setTheme(o.value)}
            className="peer sr-only"
          />
          <label
            htmlFor={`theme-${o.value}`}
            title={o.label}
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-[10px] text-muted hover:text-ink peer-checked:bg-brand-soft peer-checked:text-brand peer-focus-visible:outline-3 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-brand"
          >
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{o.icon}</svg>
            <span className="sr-only">{o.label}</span>
          </label>
        </span>
      ))}
    </fieldset>
  );
}
