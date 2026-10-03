/**
 * Theme (dark / light) with persistence that never throws.
 *
 * index.html already applies the saved class before first paint, so there is no
 * flash of the wrong theme. Every localStorage access is wrapped, because
 * storage throws in some private-browsing configurations (AC-17).
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'exposure-vite-theme';

/** Read the saved theme. Falls back to the OS preference, then to light. */
export function readStoredTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // storage unavailable — fall through to the OS preference
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme: Theme): void {
  try {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  } catch {
    // no document (SSR / test) — nothing to do
  }
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage unavailable: the toggle still works for this session
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      persistTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}