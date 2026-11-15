'use client';

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';

type TextLike = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** a text / select field of a screen the server drew: its ref, the value its state starts with, and its state's setter */
export interface AdoptField {
  ref: RefObject<TextLike | null>; initial: string; set: Dispatch<SetStateAction<string>>;
  /** the same cleaning the field's own `onChange` does (a code field keeps digits only) */
  normalize?: (value: string) => string;
  /** what the field's own `onChange` also does besides setting the value (a password field marks itself «touched») */
  onAdopted?: () => void;
}
/** a checkbox of such a screen (the hidden input's ref: Base UI Checkbox `inputRef`) */
export interface AdoptBox { ref: RefObject<HTMLInputElement | null>; initial: boolean; set: Dispatch<SetStateAction<boolean>>; onAdopted?: () => void }

/**
 * story 4937 — a screen the SERVER drew shows its fields before React has taken them over (a slow phone: seconds). What a person types in that window lives in the DOM only; React's state is still the first value, and the first re-render after it
 * writes `node.value = state` into every controlled field — the typed words vanish (name · e-mail · password → 0), and a box ticked before only flips its hidden input (the next press «un-ticks» it, no change shown).
 * Right after the screen comes alive (the effect runs once, on mount) this takes what is ON the screen into the state — the visible value becomes the state's. Nothing is locked, nothing is lost:
 * - a field is adopted only when its state is STILL the first value (a word typed after the screen came alive is never overwritten by the DOM's) and the DOM's value is another than that first value (a value the server filled — an invited e-mail — is the first value, and stays);
 * - a password goes into the state and nowhere else — the same road as typing it (nothing is logged or stored here);
 * - a browser's auto-fill (a password manager) that fills before the screen is alive takes the same road.
 */
export function useAdoptPrehydrationValues(fields: AdoptField[], boxes: AdoptBox[] = []): void {
  useEffect(() => {
    for (const f of fields) {
      const raw = f.ref.current?.value;
      const dom = typeof raw === 'string' && f.normalize ? f.normalize(raw) : raw;
      if (typeof dom === 'string' && dom !== f.initial) {
        f.set((now) => (now === f.initial ? dom : now));
        f.onAdopted?.();
      }
    }
    for (const b of boxes) {
      const dom = b.ref.current?.checked;
      if (typeof dom === 'boolean' && dom !== b.initial) {
        b.set((now) => (now === b.initial ? dom : now));
        b.onAdopted?.();
      }
    }
    // once, right after the screen is alive: the later words are React's own
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
