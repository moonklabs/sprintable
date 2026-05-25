'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

const PREFIX = 'docs:recents:';
const MAX = 5;

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function readRaw(key: string): string {
  if (typeof window === 'undefined') return '[]';
  return window.localStorage.getItem(key) ?? '[]';
}

function writeSlugs(key: string, slugs: string[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, JSON.stringify(slugs)); } catch { /* silent fallback */ }
}

export function useRecentDocs(projectId: string | undefined) {
  const key = projectId ? `${PREFIX}${projectId}` : null;

  const raw = useSyncExternalStore(
    subscribe,
    () => (key ? readRaw(key) : '[]'),
    () => '[]',
  );

  const recentSlugs = useMemo<string[]>(() => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch { return []; }
  }, [raw]);

  const pushRecent = useCallback((slug: string) => {
    if (!key) return;
    const prev = recentSlugs;
    const next = [slug, ...prev.filter((s) => s !== slug)].slice(0, MAX);
    writeSlugs(key, next);
    listeners.forEach((l) => l());
  }, [key, recentSlugs]);

  return { recentSlugs, pushRecent };
}
