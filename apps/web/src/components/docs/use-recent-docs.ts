'use client';

import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'docs:recents:';
const MAX = 5;

function readSlugs(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch { return []; }
}

function writeSlugs(key: string, slugs: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(slugs));
  } catch { /* silent fallback */ }
}

export function useRecentDocs(projectId: string | undefined) {
  const key = projectId ? `${PREFIX}${projectId}` : null;

  const [recentSlugs, setRecentSlugs] = useState<string[]>(() =>
    key ? readSlugs(key) : []
  );

  useEffect(() => {
    setRecentSlugs(key ? readSlugs(key) : []);
  }, [key]);

  const pushRecent = useCallback((slug: string) => {
    setRecentSlugs((prev) => {
      const next = [slug, ...prev.filter((s) => s !== slug)].slice(0, MAX);
      if (key) writeSlugs(key, next);
      return next;
    });
  }, [key]);

  return { recentSlugs, pushRecent };
}
