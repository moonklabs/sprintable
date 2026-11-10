// story 4891 — the notifications tab of the settings page is the rebuilt pane AND what always sat under the old card (the standup deadline · the project's gate matrix · the auto-refresh card). Rebuilding the card once dropped
// that tail by a careless range cut (caught by verify:no-unused-i18n-keys) — this pins it: the tab draws the pane first, then the three sections in order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('settings page — the notifications tab', () => {
  it('draws NotificationsPane, then StandupDeadlineSection · GateLevelMatrix · the auto-refresh card (RefreshSettings), all inside the notifications tab', () => {
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    const start = src.indexOf('<TabsContent value="notifications">');
    const end = src.indexOf('</TabsContent>', start);
    expect(start).toBeGreaterThan(-1);
    const tab = src.slice(start, end);
    const order = ['<NotificationsPane', '<StandupDeadlineSection', '<GateLevelMatrix', "t('autoRefresh')", '<RefreshSettings />'].map((needle) => tab.indexOf(needle));
    expect(order.every((i) => i > -1), `the notifications tab is missing a part: ${JSON.stringify(order)}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
