'use client';

import { useEffect, useRef, useState } from 'react';

const EDGE_THRESHOLD = 24;   // px from left edge to trigger open swipe
const OPEN_THRESHOLD = 0.3;  // 30% drag to commit open/close
const DRAWER_WIDTH = 280;    // must match layout drawer width

export function useSwipeDrawer(
  isOpen: boolean,
  onOpen: () => void,
  onClose: () => void,
) {
  const [progress, setProgress] = useState(isOpen ? 1 : 0);
  const [dragging, setDragging] = useState(false);

  const isOpenRef = useRef(isOpen);
  const activeRef = useRef(false);
  const startXRef = useRef(0);
  const startOpenRef = useRef(false);

  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);

  // Snap progress when isOpen changes externally (not during drag)
  useEffect(() => {
    if (!activeRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProgress(isOpen ? 1 : 0);
    }
  }, [isOpen]);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (window.matchMedia('(min-width: 1024px)').matches) return;
      const touch = e.touches[0];
      if (!touch) return;
      const x = touch.clientX;
      const open = isOpenRef.current;

      const fromEdge = !open && x < EDGE_THRESHOLD;
      const fromDrawer = open && x < DRAWER_WIDTH;

      if (!fromEdge && !fromDrawer) return;

      activeRef.current = true;
      startXRef.current = x;
      startOpenRef.current = open;
      setDragging(true);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!activeRef.current) return;
      const touch = e.touches[0];
      if (!touch) return;

      const dx = touch.clientX - startXRef.current;
      const p = startOpenRef.current
        ? Math.max(0, Math.min(1, 1 + dx / DRAWER_WIDTH))
        : Math.max(0, Math.min(1, dx / DRAWER_WIDTH));

      setProgress(p);
    };

    // [SID:4288 · 까디르 P1] 손을 떼면 progress를 0 · 1로 **직접** 정착시킨다. 예전엔 onOpen/onClose만 불러 isOpen이 바뀔 때의 효과에
    // 정착을 맡겼는데, 닫힌 서랍을 조금 끌다 놓으면(OPEN_THRESHOLD 미만) onClose가 불려도 isOpen이 이미 false라 효과가 안 돌고
    // progress가 0.1 따위로 남았다 — 닫힘 판정(progress 0)에서 빠져 inert가 풀린 채 화면 밖 서랍이 초점을 받았다.
    const settle = (open: boolean) => {
      setProgress(open ? 1 : 0);
      if (open) onOpen();
      else onClose();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setDragging(false);

      const touch = e.changedTouches[0];
      if (!touch) { settle(startOpenRef.current); return; } // 위치를 모르면 시작 상태로
      const dx = touch.clientX - startXRef.current;
      const p = startOpenRef.current
        ? Math.max(0, Math.min(1, 1 + dx / DRAWER_WIDTH))
        : Math.max(0, Math.min(1, dx / DRAWER_WIDTH));

      if (startOpenRef.current) settle(p > 1 - OPEN_THRESHOLD);
      else settle(p >= OPEN_THRESHOLD);
    };

    // [SID:4288 · 까디르 P1] 시스템이 터치를 가로채면(touchcancel) 끄는 중이던 진행을 시작 상태로 되돌린다 — 예전엔 처리가 없어
    // activeRef가 참으로 남고 progress가 중간값에 멈췄다.
    const onTouchCancel = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setDragging(false);
      settle(startOpenRef.current);
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [onOpen, onClose]);

  return { progress, dragging };
}

/**
 * [SID:4288] 닫힌 서랍의 속성 — 보조기술에서 숨김(aria-hidden)과 함께 초점 · 클릭에서도 뺀다(inert). 예전엔 aria-hidden +
 * 화면 밖 이동(translateX)뿐이라 Tab이 보이지 않는 서랍 속 버튼으로 들어갔다(aria-hidden 속 초점 = 접근성 위반).
 * 닫힘 = «열림 상태가 아님 && 미끄러짐이 0에 정착». isOpen을 같이 보는 이유(유나 design 4653 회귀): 여는 렌더에선 isOpen은
 * 이미 참인데 progress는 다음 효과에서야 1이 된다 — progress만 보면 그 렌더에 inert가 남아 useFocusTrap의 첫 요소 focus()가
 * 실패하고 초점이 여는 버튼에 머문다. 손으로 끄는 중(0 < progress < 1)은 둘 다 풀어 둔다. 닫을 땐 progress가 0이 되면 inert.
 */
export function closedDrawerProps(progress: number, isOpen: boolean): { 'aria-hidden': boolean; inert: boolean } {
  const closed = !isOpen && progress === 0;
  return { 'aria-hidden': closed, inert: closed };
}
