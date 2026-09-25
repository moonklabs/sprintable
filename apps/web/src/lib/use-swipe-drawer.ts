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

    const onTouchEnd = (e: TouchEvent) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setDragging(false);

      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startXRef.current;
      const p = startOpenRef.current
        ? Math.max(0, Math.min(1, 1 + dx / DRAWER_WIDTH))
        : Math.max(0, Math.min(1, dx / DRAWER_WIDTH));

      if (startOpenRef.current) {
        if (p <= 1 - OPEN_THRESHOLD) onClose();
        else onOpen();
      } else {
        if (p >= OPEN_THRESHOLD) onOpen();
        else onClose();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [onOpen, onClose]);

  return { progress, dragging };
}

/**
 * [SID:4288] 닫힌 서랍의 속성 — 보조기술에서 숨김(aria-hidden)과 함께 초점 · 클릭에서도 뺀다(inert). 예전엔 aria-hidden +
 * 화면 밖 이동(translateX)뿐이라 Tab이 보이지 않는 서랍 속 버튼으로 들어갔다(aria-hidden 속 초점 = 접근성 위반). 손으로 끄는
 * 중(0 < progress < 1)은 여는 중이라 둘 다 풀어 둔다 — 열림 · 닫힘은 progress 1 · 0으로 정착한다. 연 뒤 초점 가두기 · 닫은 뒤
 * 여는 버튼으로 초점 복귀는 각 서랍의 useFocusTrap 그대로.
 */
export function closedDrawerProps(progress: number): { 'aria-hidden': boolean; inert: boolean } {
  const closed = progress === 0;
  return { 'aria-hidden': closed, inert: closed };
}
