'use client';

import { useCallback, useState } from 'react';

/** A row is anything with a stable `key`. */
export interface SelectableRow { key: string }

/**
 * The next row after one leaves its list: the one that now sits where it was, else the last, else nothing. `before` is the section as it was when the row was still in it.
 * (The same rule the home uses — `selectAfterHandled` in `components/home/derive-home.ts`; this one only needs `{ key }`.)
 */
export function selectNextAfterLeft(before: SelectableRow[], leftKey: string): string | null {
  const i = before.findIndex((r) => r.key === leftKey);
  if (i === -1) return before[0]?.key ?? null;
  const rest = before.filter((r) => r.key !== leftKey);
  if (rest.length === 0) return null;
  return rest[Math.min(i, rest.length - 1)]!.key;
}

const signatureOf = (sections: SelectableRow[][]): string => sections.map((rows) => rows.map((r) => r.key).join('\u0001')).join('\u0002');

/**
 * Which row the detail column shows — for any «list + detail» screen (story 4909 AC3; the home does the same with its own model).
 *  · First open: `initialKey` (the first row the person has to act on).
 *  · A row the person picked stays picked while it is in the list.
 *  · When the picked row leaves the list (approved · answered · handled somewhere else · the next read no longer has it) the NEXT row is picked — the one that now sits where it was, in the SAME
 *    section it was in (a handled approval → the next approval), else `initialKey`. So the person is never left on an empty detail while rows remain.
 * The pick is re-decided while rendering, the moment the set of rows CHANGES (compared by their keys, so a new array with the same rows does not re-decide) — not in an effect,
 * so the detail never shows a row that is gone. `sections` is the rows in screen order, one array per section.
 */
export function useListSelection(sections: SelectableRow[][], initialKey: string | null): { selectedKey: string | null; select: (key: string) => void } {
  const signature = signatureOf(sections);
  const [state, setState] = useState<{ signature: string; sections: SelectableRow[][]; selectedKey: string | null }>({ signature, sections, selectedKey: initialKey });
  if (state.signature !== signature) {
    const present = new Set(sections.flat().map((r) => r.key));
    const current = state.selectedKey;
    let next: string | null;
    if (current === null) next = initialKey;
    else if (present.has(current)) next = current;
    else {
      const section = state.sections.find((rows) => rows.some((r) => r.key === current)) ?? [];
      const after = selectNextAfterLeft(section, current);
      next = after !== null && present.has(after) ? after : initialKey;
    }
    setState({ signature, sections, selectedKey: next });
  }
  const select = useCallback((key: string) => setState((s) => ({ ...s, selectedKey: key })), []);
  return { selectedKey: state.selectedKey, select };
}
