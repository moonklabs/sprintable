'use client';

import { useCallback, useEffect, useId, useRef, type HTMLAttributes, type KeyboardEvent, type RefObject } from 'react';
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

/**
 * 바깥 누름 판정(#4349 PR 2 · 유나 #4728) — `root` 밖이면서 포털된 AnchoredPopover(`[data-anchored-popover]`) 안도 아니면 바깥이다.
 * 포털 팝오버는 DOM상 body 직속이라 `root.contains`만 보면 늘 «바깥»이다. 그러면 부모가 mousedown에서 먼저 닫히고, 자식 메뉴가
 * 언마운트돼 그 누름의 click이 오지 않는다(390 문서 담당자 창 → «더 보기» → «이벤트 전달» 탭 = 디스패치 요청 0).
 * document 바깥 누름 닫기는 모두 이 규칙 하나를 쓴다(가드: `outside-press.guard.test.ts`). root가 아직 없으면 바깥 아님(예전 `ref.current &&`와 같음).
 */
export function isOutsidePress(root: Element | null | undefined, target: EventTarget | null): boolean {
  if (!root || !(target instanceof Node)) return false;
  if (root.contains(target)) return false;
  const el = target instanceof Element ? target : target.parentElement;
  return !el?.closest('[data-anchored-popover]');
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

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface PortalMenuKeysOptions {
  open: boolean;
  onClose: () => void;
  /** 포털된 팝오버(`AnchoredPopover`의 `popoverRef`). */
  popoverRef: RefObject<HTMLElement | null>;
  /** 여는 트리거 — 닫히면 초점이 여기로 돌아간다. */
  triggerRef: RefObject<HTMLElement | null>;
  /** 메뉴(항목 목록): 열면 첫 항목에 초점 · ↑↓로 옮김. 패널(여러 조작): 초점은 트리거에 두고, 트리거에서 Tab이면 패널 첫 조작으로. */
  kind: 'menu' | 'panel';
}

/**
 * story #4349 — 포털된 팝오버의 키보드 길. 포털이면 DOM 순서상 트리거 바로 뒤가 아니라서, 예전엔 Tab 한 번에 닿던 항목이 멀어진다.
 * 그 빈틈만 메운다:
 * - menu: 열면 첫 항목에 초점 · ↑↓로 옮김(끝에서 돌아감).
 * - panel: 초점은 트리거에 그대로 두고, 트리거에서 Tab이면 패널 첫 조작으로(예전 DOM 순서 그대로).
 * - 공통: 첫 조작에서 Shift+Tab이면 트리거로(panel은 열린 채 · menu는 닫고) · 마지막에서 Tab이거나 Esc면 닫고 트리거로.
 *   Esc는 전파를 멈춘다(서랍 · 셸의 초점 트랩이 document keydown에서 Esc로 자기까지 닫지 않게).
 * 돌려주는 것: 팝오버 · 트리거에 붙일 onKeyDown 둘 + **ARIA props 둘**(까디르 4724 · 부류):
 * - menu: 트리거 `aria-haspopup="menu"` · `aria-expanded` · `aria-controls`(열렸을 때 패널 id) / 팝오버 `id` · `role="menu"` — 항목 `role="menuitem"`은 호출부가 단다.
 * - panel: 트리거 `aria-expanded` · `aria-controls` / 팝오버 `id`(메뉴 역할 아님).
 * `id`도 돌려준다(패널이 둘인 자리 — 벨의 좁은 화면 오버레이 — 가 aria-controls를 제 것으로 바꿀 때).
 * `closeToTrigger`도 돌려준다(유나 #4728): 패널 안 «닫기» 버튼 같은 자리가 Esc와 같은 길(닫고 트리거로 초점)을 쓰게 — 안 그러면 누른 버튼이
 * 사라지며 초점이 body로 떨어진다.
 */
export function usePortalMenuKeys({ open, onClose, popoverRef, triggerRef, kind }: PortalMenuKeysOptions) {
  const id = useId();
  const closeToTrigger = useCallback(() => { onClose(); triggerRef.current?.focus(); }, [onClose, triggerRef]);
  useEffect(() => {
    if (open && kind === 'menu') popoverRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open, kind, popoverRef]);

  const onPopoverKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeToTrigger();
    } else if (kind === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length > 0) {
      e.preventDefault();
      const n = items.length;
      items[e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n]?.focus();
    } else if (e.key === 'Tab' && e.shiftKey && i <= 0) {
      e.preventDefault();
      if (kind === 'menu') closeToTrigger();
      else triggerRef.current?.focus();
    } else if (e.key === 'Tab' && !e.shiftKey && i === items.length - 1) {
      e.preventDefault();
      closeToTrigger();
    }
  }, [kind, closeToTrigger, triggerRef]);

  const onTriggerKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (!open || e.key !== 'Tab' || e.shiftKey) return;
    // 안 보이는 패널(예: 넓은 화면 전용 `hidden lg:flex`가 좁은 화면에서 display:none)로는 초점을 안 보낸다 — Tab을 막기만 하는 일 0.
    const pop = popoverRef.current;
    if (!pop || getComputedStyle(pop).display === 'none') return;
    const first = pop.querySelector<HTMLElement>(FOCUSABLE);
    if (!first) return;
    e.preventDefault();
    first.focus();
  }, [open, popoverRef]);

  const triggerProps = kind === 'menu'
    ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open, 'aria-controls': open ? id : undefined }
    : { 'aria-expanded': open, 'aria-controls': open ? id : undefined };
  const popoverProps = kind === 'menu' ? { id, role: 'menu' as const } : { id };
  return { onPopoverKeyDown, onTriggerKeyDown, triggerProps, popoverProps, id, closeToTrigger };
}
