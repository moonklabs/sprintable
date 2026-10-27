// story 4794 — the places that draw a NAME's first letter(s) go through `firstGraphemes` (or the canonical `initials`). A plain `name.slice(0, 1)` /
// `.charAt(0)` / `name[0]` cuts a UTF-16 unit: an emoji-first name («👩‍💻 두리») draws «�». This list is the inventory the 4794 sweep found; a site that goes back
// to the plain cut fails here. (A NEW avatar site should use the helper too — add it to the list.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const SITES = [
  'components/chat/chat-list-view.tsx',
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
