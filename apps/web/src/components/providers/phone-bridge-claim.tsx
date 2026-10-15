'use client';

import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { claimPhoneBridge, isPhoneApp, phoneCall, subscribePhoneApp } from '@/lib/phone-bridge';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';

/**
 * story #4532 — claim the phone app's signing bridge at the app root, first in <body>: the shell's one-time handle must be taken
 * before any frame can appear (a same-origin iframe would otherwise reach it on `parent`). Called in the render phase, idempotent,
 * SSR-safe, nothing outside the phone app. story #4661: this is the one place that imports the bridge; the screens read the phone
 * state (subscribed, so a claim that comes later reaches them) and the call through the context it provides.
 */
export function PhoneBridgeClaim({ children }: { children: ReactNode }) {
  claimPhoneBridge();
  const inPhoneApp = useSyncExternalStore(subscribePhoneApp, isPhoneApp, () => false);
  const value = useMemo(() => ({ inPhoneApp, phoneCall }), [inPhoneApp]);
  return <PhoneBridgeContext.Provider value={value}>{children}</PhoneBridgeContext.Provider>;
}
