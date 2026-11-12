'use client';

import { useMediaQuery } from './use-media-query';

/** story 4909 (UI-R1 AC3) — the «list + detail» width rule, one place: from 1024px the detail sits BESIDE the list (the home's rule), below it the detail is a bottom sheet. */
export function useListDetailWide(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
