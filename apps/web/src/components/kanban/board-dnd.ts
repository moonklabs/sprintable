import { useCallback, useEffect, useRef } from 'react';
import type { Announcements, KeyboardSensorOptions } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/**
 * 4908 — 보드 키보드 끌기 설정(센서 옵션 · 낭독). 보드(kanban-board.tsx)와 시험이 같은 정의를 쓴다.
 * Space로 집고 ↑↓←→로 옮기고 Space/Enter로 놓고 Esc로 취소한다. Enter 단독은 «열기»라 집지 않는다(start에 없다).
 * 잠긴(파생) 열은 놓을 자리가 아니라 건너뛴다(droppable disabled — sortableKeyboardCoordinates가 비활성 칸을 후보에서 뺀다).
 */
export const KEYBOARD_SENSOR_OPTIONS: KeyboardSensorOptions = {
  keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
  coordinateGetter: sortableKeyboardCoordinates,
};

type Translate = (key: string, values?: Record<string, string>) => string;

/** dnd-kit 기본 낭독은 영어라 한국어로: 집었을 때 · 옮기는 중 · 놓았을 때 · 취소했을 때. titleOf(카드 id → 제목) · placeOf(놓인 자리 id → 카드 제목 또는 열 이름). */
export function buildDndAccessibility(t: Translate, titleOf: (id: string | number) => string, placeOf: (id: string | number) => string): {
  announcements: Announcements;
  screenReaderInstructions: { draggable: string };
} {
  return {
    screenReaderInstructions: { draggable: t('dndInstructions') },
    announcements: {
      onDragStart: ({ active }) => t('dndPickedUp', { title: titleOf(active.id) }),
      // 자기 자신 위(막 집은 자리 · 제자리)는 «옮기는 중»이 아니다 — 집었다는 낭독을 덮어쓰지 않는다.
      onDragOver: ({ active, over }) => (over && over.id !== active.id ? t('dndMoving', { title: titleOf(active.id), to: placeOf(over.id) }) : undefined),
      onDragEnd: ({ active, over }) => (over && over.id !== active.id ? t('dndDropped', { title: titleOf(active.id), to: placeOf(over.id) }) : t('dndDroppedHome', { title: titleOf(active.id) })),
      onDragCancel: ({ active }) => t('dndCancelled', { title: titleOf(active.id) }),
    },
  };
}

/**
 * 키보드로 카드를 놓으면(다른 열로 옮기면) 카드가 새 열에서 다시 만들어져 초점이 body로 떨어진다 — dnd-kit이 놓는 순간 한 번 되돌리는 초점은 그 전에 쓰였다(신뢰축은 서버 응답으로 trust_stage가 바뀐 뒤에야 옮겨 간다).
 * 놓은 카드를 표시해 두면(markDropped) 이후 목록(deps)이 바뀔 때마다 «초점이 아무 데도 없는 동안»에 한해 그 카드로 되돌린다. 5초 뒤에는 잊는다(그 사이 사람이 다른 곳을 눌렀다면 초점이 있으니 건드리지 않는다).
 */
export function useKeyboardDropRefocus(deps: unknown): (storyId: string) => void {
  const pending = useRef<{ id: string; until: number } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    if (Date.now() > p.until) { pending.current = null; return; }
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>(`[data-story-id="${p.id}"]`)?.focus();
  }, [deps]);
  return useCallback((storyId: string) => { pending.current = { id: storyId, until: Date.now() + 5000 }; }, []);
}
