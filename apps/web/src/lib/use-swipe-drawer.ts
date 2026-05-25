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
