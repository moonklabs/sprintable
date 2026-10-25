'use client';

/**
 * story 4780 — the address of the phone's pairing screen from the page this link stands on, so that screen's [Close] can go back here (lib/pair-return.ts decides what is a valid way back).
 * The page's own address is read after hydration only (the first render = the server's: no way back) and FOLLOWS client-side navigation (`lib/location-store`: the history calls and Back / Forward), so a link that
 * stays mounted across pages — the chat head's strip lives in a layout — carries the page the person is on when they press it, not the one it was first drawn on (Kadir lens on 5232). `next/navigation`'s hooks are not
 * used: the tests that mock it in part broke when `useFlatHref` subscribed to `usePathname`.
 */
import { useSyncExternalStore } from 'react';
import { useFlatHref } from '@/hooks/use-flat-href';
import { readLocation, subscribeToLocation } from '@/lib/location-store';
import { pairReturnQuery } from '@/lib/pair-return';

export function usePairHref(): string {
  const flat = useFlatHref();
  const here = useSyncExternalStore(
    subscribeToLocation,
    readLocation,
    () => '',
  );
  return flat(`/desktop/pair${pairReturnQuery(here)}`);
}
