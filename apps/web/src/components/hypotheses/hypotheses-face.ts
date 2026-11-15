import { LAYER } from '@/components/ds/layers';

/**
 * 4909 AC3 (가설 칸 1단계) — the hypotheses card's face is the CONTENT layer (`LAYER.panel`), one step above the page: the goal screen is a whole reading area on the page layer, and its cards sit on it.
 * (The old card was `bg-muted/20` — on dev it measured −.018 (light) / −.004 (dark) against the page: a card that did not separate at all.) A constant of its own so `styles/layer-rule.test.ts` can pin it without importing the whole section.
 */
export const HYPOTHESES_FACE = LAYER.panel;

/**
 * 4909 AC3 (가설 칸 3단계) — the gate band above a hypothesis (its approval axis, a strip full width of the card) is a «글 줄»-layer face (`LAYER.rowOthers`) on the content layer, so it separates from the card by the line (≥ .05, both themes).
 * The form's inputs are the field layer (`ds` Input · Textarea · NativeSelect = `ds-surface-sunk`) on the card — also by the layer map (panel → field ≥ .05).
 */
export const HYPOTHESIS_BAND_FACE = LAYER.rowOthers;
