'use client';

import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'docs:tree:expanded:';

function readCollapsed(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsed(key: string, ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch { /* silent fallback */ }
}

export function useTreeExpanded(projectId: string | undefined) {
  const key = projectId ? `${PREFIX}${projectId}` : null;

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() =>
    key ? readCollapsed(key) : new Set()
  );

  useEffect(() => {
    setCollapsedIds(key ? readCollapsed(key) : new Set());
  }, [key]);

  const isExpanded = useCallback(
    (id: string, _defaultValue = true) => !collapsedIds.has(id),
    [collapsedIds]
  );

  const toggleExpanded = useCallback(
    (id: string) => {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (key) writeCollapsed(key, next);
        return next;
      });
    },
    [key]
  );

  return { isExpanded, toggleExpanded };
}
