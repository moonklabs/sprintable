'use client';

import { useCallback, useEffect, useRef, type HTMLAttributes, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clampIntoViewX, VIEWPORT_GUTTER_PX } from '@/hooks/use-viewport-clamp';

/**
 * story #4349 — 트리거에 붙는 팝오버를 **부모 밖(body)**에 그린다.
 * 왜: 축척 사다리 안내 팝오버(`absolute top-full`)는 담는 블록이 짧은 띠(칩 줄 `overflow-x-auto` · 사다리 `overflow-hidden`) 안이라,
 *   그 띠가 팝오버 90px를 통째로 잘랐다 — 어떤 폭에서도 안 보였다(유나 실측). 부모 overflow를 풀면 칩 줄 가로 스크롤이 죽는다.
 * 처방: body로 포털 → `position: fixed`로 트리거 사각형 바로 아래(트리거 왼쪽 + offsetX, 아래 gap)에 둔다.
 *   가로는 4342 `clampIntoViewX`(드롭다운 훅과 한 원천)로 보이는 상자 안([8, 폭 − 8])으로 민다 — fixed라 잘라내는 조상이 없어 뷰포트가 곧 상자다.
 *   어느 조상의 스크롤(칩 줄 가로 스크롤 포함 · capture) · 창 크기 바뀜마다 다시 둔다.
 * - 세로(4349 AC5 · 유나 실측 — 모바일 서랍 문서 트리 행 «⋮» 메뉴 82px가 목록 아래 끝에서 42px 잘림): 아래가 모자라고 위가 더 넓으면
 *   **위로 뒤집는다**(`placeVertical`). 어느 쪽도 다 못 담으면 넓은 쪽에 두고 [8, 높이 − 8] 안으로 민다. 고른 쪽은 `data-side`(bottom|top).
 * - 가로 기준: `align="start"`(트리거 왼쪽 + offsetX · 기본) · `"end"`(트리거 오른쪽 끝에 팝오버 오른쪽 끝 − offsetX).
 * - 바깥 클릭 판정을 하는 호출부는 `popoverRef`로 이 요소도 «안»으로 센다(포털이라 트리거 wrapper의 자손이 아니다).
 * - 열릴 때만 그린다(호출부가 `open &&`로 감싼다). SSR엔 document가 없어 아무것도 안 그린다.
 */
export interface AnchoredPopoverProps extends HTMLAttributes<HTMLDivElement> {
  /** 기준 트리거(열린 동안 붙어 있어야 한다). */
  anchorRef: RefObject<HTMLElement | null>;
  /** 트리거 왼쪽에서 더 민 거리(px) — 예전 `left-3` = 12. */
  offsetX?: number;
  /** 트리거와의 틈(px) — 예전 `mt-2` = 8. 위로 뒤집으면 트리거 위 틈. */
  gap?: number;
  /** 가로 기준 — start: 트리거 왼쪽 · end: 트리거 오른쪽 끝(예전 `right-0`). */
  align?: 'start' | 'end';
  /** 바깥 클릭 판정용 — 포털된 팝오버 요소. */
  popoverRef?: RefObject<HTMLDivElement | null>;
}

/**
 * 세로 자리 — 트리거 아래에 다 들어가면 아래. 아니면 위가 더 넓을 때 위로 뒤집는다. 고른 쪽에도 다 못 들어가면 [gutter, 높이 − gutter] 안으로 민다
 * (트리거와 조금 겹쳐도 메뉴 전부가 보이는 쪽이 낫다).
 */
export function placeVertical(
  anchor: { top: number; bottom: number }, height: number, viewportHeight: number, gap: number, gutter = VIEWPORT_GUTTER_PX,
): { top: number; side: 'bottom' | 'top' } {
  const below = viewportHeight - gutter - (anchor.bottom + gap);
  const above = anchor.top - gap - gutter;
  const fitIn = (top: number) => Math.max(gutter, Math.min(top, viewportHeight - gutter - height));
  if (height <= below || below >= above) {
    const top = anchor.bottom + gap;
    return { top: height <= below ? top : fitIn(top), side: 'bottom' };
  }
  const top = anchor.top - gap - height;
  return { top: height <= above ? top : fitIn(top), side: 'top' };
}

export function AnchoredPopover({ anchorRef, offsetX = 0, gap = 8, align = 'start', popoverRef, style, children, ...rest }: AnchoredPopoverProps) {
  const elRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const el = elRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    el.style.transform = '';
    const own = el.getBoundingClientRect();
    const v = placeVertical(a, own.height, window.innerHeight, gap);
    el.style.top = `${Math.round(v.top)}px`;
    el.style.left = `${Math.round(align === 'end' ? a.right - own.width - offsetX : a.left + offsetX)}px`;
    el.dataset.side = v.side;
    el.style.visibility = '';
    clampIntoViewX(el);
  }, [anchorRef, gap, offsetX, align]);

  // 같은 커밋에서 트리거 wrapper의 ref가 이 요소보다 **늦게** 붙을 수 있다(자식 ref가 먼저) → 붙는 순간엔 숨겨 두고,
  // 기준이 있으면 바로 · 없으면 커밋이 끝난 뒤(아래 effect) 둔다 — 0,0에 한 프레임 번쩍이는 일 0.
  const setRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    if (popoverRef) popoverRef.current = el;
    if (el) {
      el.style.visibility = 'hidden';
      place();
    }
  }, [place, popoverRef]);

  useEffect(() => {
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [place]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={setRef} data-anchored-popover="" {...rest} style={{ ...style, position: 'fixed' }}>
      {children}
    </div>,
    document.body,
  );
}
