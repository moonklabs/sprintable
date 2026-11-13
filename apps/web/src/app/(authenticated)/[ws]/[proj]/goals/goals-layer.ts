import { LAYER } from '@/components/ds/layers';

/**
 * 4909 AC3 — the goal screen is ONE reading area (head · list column · detail column, edge to edge), so its frame and its detail column stay on the PAGE layer and the cards inside it (progress · description · stories · hypotheses) are the
 * content layer above it (`LAYER.panel`). No panel is laid over the whole area (the «island» the PO ruled out on the chat room). Pinned by `styles/layer-rule.test.ts` and the goals screen test.
 */
export const GOALS_FRAME_FACE = LAYER.page;
