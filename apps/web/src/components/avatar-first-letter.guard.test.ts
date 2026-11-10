// story 4794 — the places that draw a NAME's first letter(s) go through `firstGraphemes` (or the canonical `initials`). A plain `name.slice(0, 1)` /
// `.charAt(0)` / `name[0]` cuts a UTF-16 unit: an emoji-first name («👩‍💻 두리») draws «�». This list is the inventory the 4794 sweep found; a site that goes back
// to the plain cut fails here. (A NEW avatar site should use the helper too — add it to the list.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const SITES = [
  'components/agents/messaging-policy-section.tsx',
  'components/chat/add-participant-modal.tsx',
  'components/chat/new-conversation-modal.tsx',
  'components/kanban/story-detail-panel.tsx',
  'components/kanban/story-card.tsx',
  'components/activity/dashboard-activity-timeline.tsx',
  'components/activity/team-activity-view.tsx',
  'app/(authenticated)/organization/trust/page.tsx',
  'components/nav/profile-menu.tsx',
  'components/nav/context-switcher-chip.tsx',
  'components/nav/unified-switcher.tsx',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx',
  'lib/storage/format.ts',
];
// story 4887 (UI-4 P2-b) — the room row no longer draws initials itself (the ds Avatar does, through `initials()` of lib/storage/format.ts — a site above): it must still never cut a name by hand
const NO_INITIALS_OF_ITS_OWN = ['components/chat/chat-list-view.tsx'];
const PLAIN_CUT = /(?:name|label|Name|first|parts\[\d\]\s*\?\?\s*''|\bw|\bs)\s*(?:\.trim\(\))?\s*(?:\.charAt\(0\)|\.slice\(0, ?[12]\)|\[0\]!?)/;

describe('[SID:4794] avatar first letters are whole letters', () => {
  for (const file of SITES) {
    it(`${file} uses firstGraphemes and has no plain cut of a name`, () => {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, 'uses firstGraphemes').toContain('firstGraphemes(');
      const offenders = text.split('\n').filter((l) => !l.trim().startsWith('//') && PLAIN_CUT.test(l) && /name|label|initial|first|\bw\b|\bs\b/i.test(l));
      expect(offenders).toEqual([]);
    });
  }
});

describe('[SID:4794] files that no longer draw initials still do not cut a name by hand', () => {
  for (const file of NO_INITIALS_OF_ITS_OWN) {
    it(`${file} has no plain cut of a name`, () => {
      const text = readFileSync(join(SRC, file), 'utf8');
      const offenders = text.split('\n').filter((l) => !l.trim().startsWith('//') && PLAIN_CUT.test(l) && /name|label|initial|first|\bw\b|\bs\b/i.test(l));
      expect(offenders).toEqual([]);
    });
  }
});
