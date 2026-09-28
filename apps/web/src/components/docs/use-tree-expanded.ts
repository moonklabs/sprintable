'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

const PREFIX = 'docs:tree:expanded:';

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function readRaw(key: string): string {
  if (typeof window === 'undefined') return '[]';
  return window.localStorage.getItem(key) ?? '[]';
}

function writeCollapsed(key: string, ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, JSON.stringify([...ids])); } catch { /* silent fallback */ }
}

export function useTreeExpanded(projectId: string | undefined) {
  const key = projectId ? `${PREFIX}${projectId}` : null;

  const raw = useSyncExternalStore(
    subscribe,
    () => (key ? readRaw(key) : '[]'),
    () => '[]',
  );

  const collapsedIds = useMemo<Set<string>>(() => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? new Set<string>(parsed as string[]) : new Set<string>();
    } catch { return new Set<string>(); }
  }, [raw]);

  const isExpanded = useCallback(
    (id: string, _defaultValue = true) => !collapsedIds.has(id),
    [collapsedIds],
  );

  const toggleExpanded = useCallback(
    (id: string) => {
      if (!key) return;
      const current = new Set<string>(collapsedIds);
      if (current.has(id)) current.delete(id); else current.add(id);
      writeCollapsed(key, current);
      listeners.forEach((l) => l());
    },
    [key, collapsedIds],
  );

  const expandFolder = useCallback(
    (id: string) => {
      if (!key) return;
      const current = new Set<string>(collapsedIds);
      current.delete(id);
      writeCollapsed(key, current);
      listeners.forEach((l) => l());
    },
    [key, collapsedIds],
  );

  // story #4348 — 여러 폴더를 한 번에 펼침(«⋮» 폴더로 이동: 목표 폴더 + 조상). expandFolder를 잇달아 부르면 매번 같은 옛 스냅숏에서 시작해
  // 마지막 하나만 남는다 → 한 번에 지우고 한 번 쓴다.
  const expandFolders = useCallback(
    (ids: string[]) => {
      if (!key) return;
      const current = new Set<string>(collapsedIds);
      let changed = false;
      for (const id of ids) changed = current.delete(id) || changed;
      if (!changed) return;
      writeCollapsed(key, current);
      listeners.forEach((l) => l());
    },
    [key, collapsedIds],
  );

  return { isExpanded, toggleExpanded, expandFolder, expandFolders };
}
