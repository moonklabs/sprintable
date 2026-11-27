'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useListDetailWide } from './use-list-detail-wide';

/**
 * story 5031 (C1 step 5c · PO ii) — «does the detail sit BESIDE the list?» decided by the width the screen's body ACTUALLY received (a wrapper the caller puts around the list-detail shell, `ref`), not by the window.
 * It is the usual rule (`useListDetailWide`: from 1024 px) AND the body is at least `minWidth` wide. Everything else (the agents frame · the inbox tabs) keeps `useListDetailWide` alone.
 * The first render — the server's, and the client's while it has not measured — says «not beside» (the sheet): the same as the server, so no hydration mismatch; the width is read in a layout effect (before paint) and followed by a ResizeObserver, so the browser never shows the wrong shape.
 * No ResizeObserver (a test · an old browser): the usual rule alone, as before.
 */
export function useDetailBesideList(minWidth: number): { ref: React.RefObject<HTMLDivElement | null>; wide: boolean } {
  const usual = useListDetailWide();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const canMeasure = typeof ResizeObserver !== 'undefined';
  return { ref, wide: usual && (canMeasure ? width !== null && width >= minWidth : true) };
}
