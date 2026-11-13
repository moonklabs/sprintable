'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useDsPortalContainer } from '@/components/ds/portal-container';

/**
 * story #4923 — 보드 머리가 «한 줄에 안 들어가면» 거르기 묶음이 단추 하나(«거르기 · n»)로 접히고, 누르면 지금의 거르기 조작이 전부 든 팝오버가 열린다.
 * 접는 조건은 창 높이가 아니라 **머리 줄의 폭**이다: 래더 · 거르기 · 보기 전환 세 묶음이 한 줄에 필요한 폭(`need`)이 머리 폭(`available`)보다 크면 접는다(1440 같은 넉넉한 폭은 펼친 채).
 * 줄바꿈(3줄 · 123px — dev 1100×420 실측)을 줄바꿈 대신 한 줄(≈ 38px)로 바꾸는 것이 목적이다. 폰(lg 아래)은 원래 «가로로 미는 한 줄»이라 이 접기를 안 쓴다.
 */
export const HEAD_GAP_PX = 8; // 머리 줄 gap-2

/** 접어야 하나: 펼친 머리가 필요로 하는 폭이 머리 폭을 넘을 때(서브픽셀 오차 0.5 허용). */
export function needsFold(need: number, available: number): boolean {
  return need > available + 0.5;
}

/** 다시 펼쳐도 되나: 머리 폭이 «펼쳤을 때 필요한 폭» 이상일 때(접은 동안은 그 폭을 직전 펼친 상태에서 잰 값으로 기억한다). */
export function mayUnfold(need: number, available: number): boolean {
  return available + 0.5 >= need;
}

const DESKTOP = '(min-width: 1024px)';

/**
 * 머리 줄(headRef)이 접혀야 하는지. 줄의 직계 자식 폭 합 + 사이 간격 + 안쪽 여백 = 펼쳤을 때 필요한 폭.
 * `contentKey`가 바뀌면(칩이 늘거나 줄 때) 다시 잰다. lg 아래(폰)는 늘 false.
 */
export function useHeadFold(headRef: RefObject<HTMLElement | null>, contentKey: string): boolean {
  const [folded, setFolded] = useState(false);
  const foldedRef = useRef(false);
  const needRef = useRef(0);
  const measure = useCallback(() => {
    const el = headRef.current;
    if (!el) return;
    const set = (v: boolean) => { if (foldedRef.current !== v) { foldedRef.current = v; setFolded(v); } };
    // 창 환경이 matchMedia를 모르면(시험 · 아주 옛 브라우저) 접지 않는다 — 펼친 머리가 예전 모양 그대로다.
    if (typeof window.matchMedia !== 'function' || !window.matchMedia(DESKTOP).matches) { set(false); return; }
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const available = el.clientWidth;
    if (!foldedRef.current) {
      const kids = Array.from(el.children) as HTMLElement[];
      needRef.current = kids.reduce((w, k) => w + k.offsetWidth, 0) + HEAD_GAP_PX * Math.max(0, kids.length - 1) + pad;
      if (needsFold(needRef.current, available)) set(true);
    } else if (mayUnfold(needRef.current, available)) {
      set(false);
    }
  }, [headRef]);
  useLayoutEffect(() => {
    measure();
    const el = headRef.current;
    if (!el) return undefined;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(DESKTOP) : null;
    mq?.addEventListener('change', measure);
    return () => { ro?.disconnect(); mq?.removeEventListener('change', measure); };
  }, [measure, headRef, contentKey]);
  return folded;
}

export interface HeadFilterFoldProps {
  folded: boolean;
  /** 적용 중인 거르기 수(0이면 단추는 «거르기»만). */
  count: number;
  /** 단추 글 — 호출부가 `t()`로 만든다(글 목록의 literal 키). */
  label: string;
  labelActive: string;
  /** 팝오버(dialog)의 접근성 이름. */
  popoverLabel: string;
  /** 거르기 조작 전부(담당자 종류 탭 · 스프린트 · 목표 · 담당자 · 라벨 칩) — 펼친 줄에서도 접힌 팝오버에서도 같은 요소다. */
  children: ReactNode;
  /** «숨긴 N» — 거르기와 무관하게 늘 보여야 하는 어포던스(story #2187)라 접히지 않는다. */
  excluded?: ReactNode;
}

export function HeadFilterFold({ folded, count, label, labelActive, popoverLabel, children, excluded }: HeadFilterFoldProps) {
  const portalContainer = useDsPortalContainer();
  if (!folded) {
    return (
      <div data-slot="board-head-filters" data-folded="false" className="flex shrink-0 items-center gap-1 lg:flex-wrap">
        {children}
        {excluded}
      </div>
    );
  }
  return (
    <div data-slot="board-head-filters" data-folded="true" className="flex shrink-0 items-center gap-1">
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger
          render={<Button type="button" variant="secondary" data-testid="board-filter-fold" iconStart={<Icon name="filter_list" />} />}
        >
          {count > 0 ? labelActive : label}
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
          <PopoverPrimitive.Positioner className="isolate z-50 outline-none" align="start" sideOffset={4}>
            <PopoverPrimitive.Popup
              aria-label={popoverLabel}
              data-slot="board-filter-popover"
              className="z-50 w-[min(26rem,var(--available-width))] origin-(--transform-origin) rounded-ds-panel border border-ds-line-control bg-ds-surface-raised p-3 text-ds-body text-ds-ink shadow-ds-overlay outline-none"
            >
              <div className="flex flex-wrap items-center gap-1.5">{children}</div>
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      {excluded}
    </div>
  );
}
