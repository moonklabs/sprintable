import type { WorkListRow } from './derive-work-list';

/** story #4888 — the row that stands for a story itself (what `deriveWorkList` puts in `selfRow`), for tests that build a story group by hand */
export function storySelfRow(storyId: string, title: string, over: Partial<WorkListRow> = {}): WorkListRow {
  return {
    id: `story:${storyId}`, kind: 'story', workItemType: 'story', workItemId: storyId, title,
    ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0, state: null, ...over,
  };
}
