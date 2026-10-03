'use client';

import { claimPhoneBridge } from '@/lib/phone-bridge';

/**
 * story #4532 — claim the phone app's signing bridge at the app root, first in <body>: the shell's one-time handle must be taken
 * before any frame can appear (a same-origin iframe would otherwise reach it on `parent`). Called in the render phase, like
 * FetchGateInstaller — idempotent · SSR-safe · nothing outside the phone app.
 */
export function PhoneBridgeClaim(): null {
  claimPhoneBridge();
  return null;
}
