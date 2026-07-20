import { PointerSensor, useSensor, useSensors } from '@dnd-kit/core';

/**
 * story #1988(C, 유나 UX 감사) — kanban-board.tsx의 터치-드래그 하이재킹 fix(0d142311,
 * 프로덕션 재발 근본 원인)를 dnd-kit을 쓰는 다른 표면(retro 아이템 그룹핑·doc-tree 재정렬)에도
 * 동일 적용하기 위한 공유 센서. 순수 PointerSensor(distance constraint만)는 터치 스크롤
 * 제스처를 드래그로 오인해 하이재킹한다 — pointerType!=='touch'로 터치는 아예 드래그 활성화
 * 자체를 하지 않게 배제해야 네이티브 스크롤이 보존된다.
 */
class MousePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) =>
        nativeEvent.isPrimary && nativeEvent.button === 0 && nativeEvent.pointerType !== 'touch',
    },
  ];
}

export function useTouchSafePointerSensor(distance: number) {
  return useSensors(useSensor(MousePointerSensor, { activationConstraint: { distance } }));
}
