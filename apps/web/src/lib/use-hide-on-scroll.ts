'use client';
import { useEffect, useRef, useState } from 'react';

interface Options {
  enabled: boolean;
  scrollContainer: HTMLElement | null;
  deltaThreshold?: number;
  nearTopThreshold?: number;
}

export function useHideOnScroll({
  enabled,
  scrollContainer,
  deltaThreshold = 8,
  nearTopThreshold = 32,
}: Options): boolean {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    if (!enabled || !scrollContainer) return;

    lastY.current = scrollContainer.scrollTop;

    const handler = () => {
      const currentY = scrollContainer.scrollTop;
      const delta = currentY - lastY.current;

      if (currentY <= nearTopThreshold) {
        setHidden(false);
      } else if (delta > deltaThreshold) {
        setHidden(true);
        lastY.current = currentY;
      } else if (delta < -deltaThreshold) {
        setHidden(false);
        lastY.current = currentY;
      }
    };

    scrollContainer.addEventListener('scroll', handler, { passive: true });
    return () => {
      scrollContainer.removeEventListener('scroll', handler);
      setHidden(false);
    };
  }, [enabled, scrollContainer, deltaThreshold, nearTopThreshold]);

  return hidden;
}
