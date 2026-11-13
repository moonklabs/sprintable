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
