'use client';

import { useEffect, useRef } from 'react';
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
 * Screens of one or SEVERAL computers are in front (the room of an agent · the approvals that wait for answers · a computer's files): the phone's same-network road to each is made if it is not there and kept alive while the screen stays (lib/phone-direct-keep.ts).
 * One keeper per computer however many screens hold it (a count): a room and an approval card of the same computer share one road, and the limits of the keeper (an hour · a minute · the doubling wait) are the page's, not the screen's. A computer that leaves the list is let go (its road closes after the grace); one that stays is not touched — no new look, no churn.
 * Outside the phone app, or with no computer to ask about, it does nothing.
 */
export function useDirectRoads(setupIds: readonly (string | undefined)[]): void {
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  const held = useRef(new Map<string, () => void>());
  const key = inPhoneApp ? [...new Set(setupIds.filter((x): x is string => typeof x === 'string' && x !== ''))].sort().join(',') : '';
  useEffect(() => {
    const want = new Set(key === '' ? [] : key.split(','));
    for (const [id, release] of [...held.current]) if (!want.has(id)) { release(); held.current.delete(id); }
    for (const id of want) if (!held.current.has(id)) held.current.set(id, holdDirectRoad(id, browserEnv(phoneCall)));
  }, [key, phoneCall]);
  useEffect(() => { const mine = held.current; return () => { for (const release of mine.values()) release(); mine.clear(); }; }, []);
}

/** A screen of this computer (the room of one of its agents) is in front — the one-computer form of `useDirectRoads`. */
export function useDirectRoad(setupId: string | undefined): void { useDirectRoads([setupId]); }
