import { describe, it, expect } from 'vitest';
import en from '../../../../../../../messages/en.json';
import ko from '../../../../../../../messages/ko.json';

// story 4906 — «0 revisions» in the editor header after three saves. A «revision» is the saved copy of a version that was REJECTED and then taken back to a draft to be fixed
// (backend DocRevision: one snapshot on denied → draft) — not a count of saves, so 0 is right for a fresh doc; the WORDS made it read as «0 edits». The header now says what the
// number is, and nothing while there is none (the reading header already hid the zero).
describe('editor header — the revisions number says what it counts (story 4906)', () => {
  it('⭐words: «이전 판 N개» / «N earlier versions» (not «수정 이력» / «revisions»)', () => {
    const koMeta = (ko as unknown as { docs: Record<string, string> }).docs.docMetaRevisions;
    const enMeta = (en as unknown as { docs: Record<string, string> }).docs.docMetaRevisions;
    expect(koMeta).toBe('이전 판 {count}개');
    expect(enMeta).toBe('{count, plural, one {# earlier version} other {# earlier versions}}');
    expect(koMeta).not.toContain('수정 이력');
    expect(enMeta).not.toMatch(/revision/i);
  });

  it('⭐no number while there is none: the header draws it only for a count above 0', async () => {
    const src = (await import('./page.tsx?raw')).default as string;
    expect(src).toMatch(/revisionCount != null && revisionCount > 0 \? \(/);
    // the reading header's rule is the same one (v{count} only when there is something)
    const view = (await import('./view/page.tsx?raw')).default as string;
    expect(view).toContain('doc.revisions?.count ?');
  });
});
