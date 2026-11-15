'use client';

import { useMemo } from 'react';
import { useListSelection } from '@/hooks/use-list-selection';
import type { HomeModel } from './derive-home';

/**
 * story #4888 (UI-5 home, AC3 §1) — which row the detail column shows.
 *  · First open: the first row that needs a hand (`model.initialSelection`).
 *  · A row the person picked stays picked while it is in the list.
 *  · When the picked row leaves the list (approved · answered · handled somewhere else · the 60-second read no longer has it) the NEXT row is picked — the one that now sits where it was,
 *    in the SAME section it was in, else the first row that needs a hand — so the person is never left on an empty detail while rows remain (the «3 taps → 1» rule).
 * Story 4909 (UI-R1 AC3): the rule itself now lives in the generic `useListSelection` (the inbox's screens use it too); the home only hands it its three sections.
 */
export function useHomeSelection(model: HomeModel): { selectedKey: string | null; select: (key: string) => void } {
  const sections = useMemo(() => [model.needsHand, model.working, model.justDone], [model]);
  return useListSelection(sections, model.initialSelection);
}
