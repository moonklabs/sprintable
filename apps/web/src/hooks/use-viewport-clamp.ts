'use client';

import { useCallback, useRef } from 'react';

/**
 * story #4342 — 한쪽에 맞춘 고정 폭 드롭다운(`absolute right-0|left-0 … w-64` 등)이 좁은 화면에서 뷰포트 밖으로 나가던 결함(유나 390px 실측:
 * 문서 목차 왼쪽으로 37px). 열릴 때 제 위치를 재서 **보이는 상자 안(양쪽 8px 여백)으로 가로만 밀어 넣는다**. 넘치지 않으면 아무것도 안 한다(넓은 화면 모양 그대로).
 * - **보이는 상자 = 뷰포트 ∩ 패널을 잘라내는 모든 조상(overflow ≠ visible)의 안쪽 상자**(유나 4714 CHANGES): 목차 · md 복사 실패 패널은
 *   문서 에디터 카드(`overflow-hidden` · 16px 안쪽) 안이라, 뷰포트 기준 8px 여백으로는 카드 가장자리에서 한 변이 여전히 잘렸다.
 *   잘라내는 조상은 CSS 규칙대로 셈한다 — absolute 패널은 **담는 블록(가장 가까운 positioned · transform 조상)부터 위로**만(그 아래 overflow는 못 자른다).
 * - 패널이 그 상자(− 여백 둘)보다 넓으면 인라인 `max-width`로 줄인다(호출부 `max-w-[calc(100vw-1rem)]`는 뷰포트만 안다).
 * - 인라인 `transform: translateX()`를 쓴다 — Tailwind v4의 translate 유틸(개별 `translate` 속성)과 안 겹친다.
 */
export const VIEWPORT_GUTTER_PX = 8;

/** 가로 상자 [left, right](px · 뷰포트 좌표). */
export interface ClipBoxX { left: number; right: number }

/** 가로로 얼마나 밀어야 [box.left + gutter, box.right − gutter] 안에 드는가(px · 오른쪽 +). 왼쪽 넘침이 먼저(글 시작 · 표식이 잘리는 쪽). */
export function shiftIntoBoxX(rect: { left: number; right: number }, box: ClipBoxX, gutter: number = VIEWPORT_GUTTER_PX): number {
  const lo = box.left + gutter;
  const hi = box.right - gutter;
  if (rect.left < lo) return lo - rect.left;
  if (rect.right > hi) return Math.max(lo - rect.left, hi - rect.right);
  return 0;
}

/** 뷰포트만 기준(잘라내는 조상이 없을 때 — 예: body로 포털한 fixed 팝오버). */
export function viewportShiftX(rect: { left: number; right: number }, viewportWidth: number, gutter: number = VIEWPORT_GUTTER_PX): number {
  return shiftIntoBoxX(rect, { left: 0, right: viewportWidth }, gutter);
}

function viewportWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

const clips = (s: CSSStyleDeclaration) =>
  [s.overflow, s.overflowX, s.overflowY].some((v) => !!v && v !== 'visible');
const isContainingBlock = (s: CSSStyleDeclaration) => s.position !== 'static' || (!!s.transform && s.transform !== 'none');

/**
 * 패널이 실제로 보일 수 있는 가로 상자 = 뷰포트 ∩ 잘라내는 조상들의 안쪽(padding) 상자.
 * - fixed 패널: 뷰포트만(조상 overflow에 안 잘린다).
 * - absolute 패널: 담는 블록부터 위로 overflow ≠ visible 조상.
 * - 그 밖(흐름 안): 부모부터 위로.
 */
export function clipBoxX(el: HTMLElement): ClipBoxX {
  let left = 0;
  let right = viewportWidth();
  const pos = getComputedStyle(el).position;
  if (pos === 'fixed') return { left, right };
  let a = el.parentElement;
  if (pos === 'absolute') {
    while (a && a !== document.body && !isContainingBlock(getComputedStyle(a))) a = a.parentElement;
  }
  for (; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    if (!clips(getComputedStyle(a))) continue;
    const inner = a.getBoundingClientRect().left + a.clientLeft;
    left = Math.max(left, inner);
    right = Math.min(right, inner + a.clientWidth);
  }
  return { left, right };
}

/** 한 번 두기: 되돌림 → 재기 → (넓으면) max-width로 줄임 → 보이는 상자 안으로 translateX. 폭 0(숨은 패널)은 안 건드린다. */
export function clampIntoViewX(el: HTMLElement, box: ClipBoxX = clipBoxX(el), gutter: number = VIEWPORT_GUTTER_PX): void {
  el.style.transform = '';
  el.style.maxWidth = '';
  let rect = el.getBoundingClientRect();
  if (rect.width === 0) return;
  const room = Math.floor(box.right - box.left - 2 * gutter);
  if (room > 0 && rect.width > room) {
    el.style.maxWidth = `${room}px`;
    rect = el.getBoundingClientRect();
  }
  const shift = shiftIntoBoxX(rect, box, gutter);
  el.style.transform = shift ? `translateX(${shift}px)` : '';
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
    const place = () => clampIntoViewX(el);
    place();
    window.addEventListener('resize', place);
    cleanupRef.current = () => window.removeEventListener('resize', place);
  }, [active]);
}
