import type { KeyboardEvent } from 'react';

/**
 * story 4945 — 일감 목록의 행 사이 방향키: ↑↓ = 화면 순서의 이웃 행으로 초점(고르는 것은 Enter · 클릭 — 보드 카드와 같은 손). 행 = `data-work-row`가 달린 눌리는 요소(스토리 행 · 그 밑 일 행).
 * 글자 칸 안 · 수정 키가 같이 눌린 것 · 행이 아닌 곳(구간 머리 단추 · 필터)에서는 아무것도 안 한다.
 */
export function moveWorkRowFocus(e: KeyboardEvent<HTMLElement>): void {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-work-row]')];
  const here = rows.indexOf(target);
  if (here < 0) return;
  const next = rows[here + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView?.({ block: 'nearest' });
}
