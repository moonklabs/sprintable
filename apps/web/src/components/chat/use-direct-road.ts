'use client';

import { useEffect } from 'react';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { holdDirectRoad, type KeepEnv } from '@/lib/phone-direct-keep';

/** the page's own clock and visibility (story 4993 · PO ⓐ: the road is kept while the screen is in front) */
const browserEnv = (phoneCall: KeepEnv['phoneCall']): KeepEnv => ({
  phoneCall,
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onVisibility: (cb) => { if (typeof document === 'undefined') return () => {}; document.addEventListener('visibilitychange', cb); return () => document.removeEventListener('visibilitychange', cb); },
  timer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
});

/**
 * A screen of this computer (the room of one of its agents) is in front: the phone's same-network road to it is made if it is not there and kept alive while the screen stays (lib/phone-direct-keep.ts). Outside the phone app, or without a computer to ask about, it does nothing.
 */
export function useDirectRoad(setupId: string | undefined): void {
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  useEffect(() => {
    if (!inPhoneApp || !setupId) return undefined;
    return holdDirectRoad(setupId, browserEnv(phoneCall));
  }, [inPhoneApp, setupId, phoneCall]);
}
