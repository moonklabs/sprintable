import { LAYER } from '@/components/ds/layers';

/**
 * 4909 AC3 (가설 칸 1단계) — the hypotheses card's face is the CONTENT layer (`LAYER.panel`), one step above the page: the goal screen is a whole reading area on the page layer, and its cards sit on it.
 * (The old card was `bg-muted/20` — on dev it measured −.018 (light) / −.004 (dark) against the page: a card that did not separate at all.) A constant of its own so `styles/layer-rule.test.ts` can pin it without importing the whole section.
 */
export const HYPOTHESES_FACE = LAYER.panel;
