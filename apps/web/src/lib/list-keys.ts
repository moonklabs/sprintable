import type { KeyboardEvent } from 'react';

/**
 * story #4888 (UI-5) — the list move keys shared by the screens that are a list + a detail column (home, goals).
 * A letter or arrow pressed while the focus is inside the list (never while someone types in a field) walks the rows that are on screen: j / ↓ the next one, k / ↑ the one before.
 * A row is any element with a `data-row-key`; the key goes to `onSelect`, and the focus follows to the row's `[data-row-focus]` element (its title button) — or, when a row marks none, its first button. No new command key: it only walks the list.
 * (Moved here from home-list.tsx with no change in behaviour, so the goals list does not carry a second copy.)
 */
export function handleListKeys(e: KeyboardEvent<HTMLElement>, onSelect: (key: string) => void) {
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const dir = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
  if (dir === 0) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row-key]')];
  const here = rows.findIndex((r) => r.contains(target));
  const next = rows[here === -1 ? (dir === 1 ? 0 : rows.length - 1) : here + dir];
  if (!next) return;
  e.preventDefault();
  const key = next.getAttribute('data-row-key');
  if (key) onSelect(key);
  (next.querySelector<HTMLElement>('[data-row-focus]') ?? next.querySelector<HTMLElement>('button'))?.focus();
}
