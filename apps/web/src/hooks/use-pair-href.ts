'use client';

/**
 * story 4780 — the address of the phone's pairing screen from the page this link stands on, so that screen's [Close] can go back here (lib/pair-return.ts decides what is a valid way back).
 * The page's own address is read after hydration only (the first render = the server's: no way back) and without subscribing to navigation — the same reason as `useFlatHref`'s tab project
 * (a subscription broke the tests that mock next/navigation in part). A link is drawn again when its page is, so the value is the page's own at that time.
 */
import { useSyncExternalStore } from 'react';
import { useFlatHref } from '@/hooks/use-flat-href';
import { pairReturnQuery } from '@/lib/pair-return';

const noopSubscribe = () => () => {};

export function usePairHref(): string {
  const flat = useFlatHref();
  const here = useSyncExternalStore(
    noopSubscribe,
    () => `${window.location.pathname}${window.location.search}`,
    () => '',
  );
  return flat(`/desktop/pair${pairReturnQuery(here)}`);
}
