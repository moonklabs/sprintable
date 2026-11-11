'use client';

import { useCallback, useState } from 'react';
import { selectAfterHandled, type HomeModel } from './derive-home';

/**
 * story #4888 (UI-5 home, AC3 §1) — which row the detail column shows.
 *  · First open: the first row that needs a hand (`model.initialSelection`).
 *  · A row the person picked stays picked while it is in the list.
 *  · When the picked row leaves the list (approved · answered · handled somewhere else · the 60-second read no longer has it) the NEXT row is picked — `selectAfterHandled`, the one that now
 *    sits where it was, else the last, else the first — so the person is never left on an empty detail while rows remain (the «3 taps → 1» rule).
 * The pick is re-decided while rendering, the moment a new model arrives (React's «adjust state when a value changes» pattern) — not in an effect, so the detail never shows a row that is gone.
 */
export function useHomeSelection(model: HomeModel): { selectedKey: string | null; select: (key: string) => void } {
  const [state, setState] = useState<{ model: HomeModel; selectedKey: string | null }>({ model, selectedKey: model.initialSelection });
  if (state.model !== model) {
    const present = new Set([...model.needsHand, ...model.working, ...model.justDone].map((r) => r.key));
    const current = state.selectedKey;
    let next: string | null;
    if (current === null) next = model.initialSelection;
    else if (present.has(current)) next = current;
    else {
      const after = selectAfterHandled(state.model.needsHand, current);
      next = after !== null && present.has(after) ? after : model.initialSelection;
    }
    setState({ model, selectedKey: next });
  }
  const select = useCallback((key: string) => setState((s) => ({ ...s, selectedKey: key })), []);
  return { selectedKey: state.selectedKey, select };
}
