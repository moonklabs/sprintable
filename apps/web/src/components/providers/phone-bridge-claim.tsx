'use client';

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { deviceKindOf } from '@/lib/device-kind';
import { claimPhoneBridge, isPhoneApp, phoneCall, subscribePhoneApp } from '@/lib/phone-bridge';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import { ON_OPEN_MS, startHandoffWatch, stopHandoffWatch } from '@/lib/phone-handoff-watch';

/**
 * story #4532 — claim the phone app's signing bridge at the app root, first in <body>: the shell's one-time handle must be taken
 * before any frame can appear (a same-origin iframe would otherwise reach it on `parent`). Called in the render phase, idempotent,
 * SSR-safe, nothing outside the phone app. story #4661: this is the one place that imports the bridge; the screens read the phone
 * state (subscribed, so a claim that comes later reaches them) and the call through the context it provides.
 */
export function PhoneBridgeClaim({ children }: { children: ReactNode }) {
  claimPhoneBridge();
  const inPhoneApp = useSyncExternalStore(subscribePhoneApp, isPhoneApp, () => false);
  const deviceKind = typeof navigator === 'undefined' ? 'phone' : deviceKindOf(navigator.userAgent); // (read where the page runs: the guest desktop app's window says `Electron/`)
  const value = useMemo(() => ({ inPhoneApp, deviceKind, phoneCall }), [inPhoneApp, deviceKind]);
  // story 4978 (C1b-phone): in the phone app, a look for the record key handoffs computers put for this phone — when the app opens and each time it comes back to the front (a computer may have sealed a new envelope while it was away), for a short while.
  // Outside the phone app nothing is looked for; a page that goes away ends the watch.
  useEffect(() => {
    if (!inPhoneApp) return undefined;
    const look = () => { if (document.visibilityState === 'visible') startHandoffWatch({ phoneCall, forMs: ON_OPEN_MS }); };
    look();
    document.addEventListener('visibilitychange', look);
    return () => { document.removeEventListener('visibilitychange', look); stopHandoffWatch(); };
  }, [inPhoneApp]);
  return <PhoneBridgeContext.Provider value={value}>{children}</PhoneBridgeContext.Provider>;
}
