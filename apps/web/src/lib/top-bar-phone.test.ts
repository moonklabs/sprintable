// story 5031 (C1 step 5a follow-up · PO 11-27) — a phone's settings keeps NO top bar (as before 5a); every other screen, and settings from lg, has it. The one place that says which screens: lib/top-bar-phone.ts.
import { describe, expect, it } from 'vitest';
import { BAR_HIDDEN_ON_PHONE_CLASS, barHiddenOnPhone } from './top-bar-phone';

describe('barHiddenOnPhone', () => {
  const table: Array<[string, boolean]> = [
    ['/settings', true],
    ['/settings/integrations', true],
    ['/org-briefing', false],
    ['/inbox', false],
    ['/chats', false],
    ['/chats/room-1', false],
    ['/organization/workforce', false],
    ['/organization/members', false], // a settings-place screen that always had the bar
    ['/acme/sprintable/flow', false],
  ];
  for (const [path, hidden] of table) it(`${path} → ${hidden ? 'no bar on a phone' : 'the bar on every width'}`, () => expect(barHiddenOnPhone(path)).toBe(hidden));

  it('the class is the below-lg one (a lg-and-up window never loses the bar)', () => {
    expect(BAR_HIDDEN_ON_PHONE_CLASS).toBe('max-lg:hidden');
  });
});
