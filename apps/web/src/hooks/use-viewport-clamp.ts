'use client';

import { useCallback, useRef } from 'react';

/**
 * story #4342 — 한쪽에 맞춘 고정 폭 드롭다운(`absolute right-0|left-0 … w-64` 등)이 좁은 화면에서 뷰포트 밖으로 나가던 결함(유나 390px 실측:
 * 문서 목차 왼쪽으로 37px). 열릴 때 제 위치를 재서 **뷰포트 안(양쪽 8px 여백)으로 가로만 밀어 넣는다**. 넘치지 않으면 아무것도 안 한다(넓은 화면 모양 그대로).
 * - 폭 자체가 뷰포트보다 크면 호출부의 `max-w-[calc(100vw-1rem)]`가 먼저 줄인다(밀어 넣기만으로는 양쪽이 다 들어갈 수 없다).
 * - 인라인 `transform: translateX()`를 쓴다 — Tailwind v4의 translate 유틸(개별 `translate` 속성)과 안 겹친다.
 */
export const VIEWPORT_GUTTER_PX = 8;

/** 가로로 얼마나 밀어야 [gutter, 폭 - gutter] 안에 드는가(px · 오른쪽 +). 왼쪽 넘침이 먼저(글 시작 · 표식이 잘리는 쪽). */
export function viewportShiftX(rect: { left: number; right: number }, viewportWidth: number, gutter: number = VIEWPORT_GUTTER_PX): number {
  if (rect.left < gutter) return gutter - rect.left;
  if (rect.right > viewportWidth - gutter) return Math.max(gutter - rect.left, viewportWidth - gutter - rect.right);
  return 0;
}

function viewportWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

/**
 * 드롭다운 패널에 거는 callback ref — 패널이 붙는 순간(열림) 재서 밀어 넣고, 창 크기가 바뀌면 다시 잰다. 떨어지면(닫힘) 듣기를 푼다.
 * - 이미 ref가 있는 패널은 `ref={(el) => { ownRef.current = el; clampRef(el); }}`로 함께 건다.
 * - 늘 붙어 있고 클래스로만 숨기는 패널은 `active`(열림 상태)를 넘긴다 — 값이 바뀌면 ref가 다시 걸려 열린 모양으로 다시 잰다.
 * - 숨은 패널(폭 0)은 재지 않는다.
 */
export function useViewportClampRef<T extends HTMLElement = HTMLElement>(active: unknown = true): (el: T | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el || !active) return;
    const place = () => {
      el.style.transform = '';
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      const shift = viewportShiftX(rect, viewportWidth());
      el.style.transform = shift ? `translateX(${shift}px)` : '';
    };
    place();
    window.addEventListener('resize', place);
    cleanupRef.current = () => window.removeEventListener('resize', place);
  }, [active]);
}
