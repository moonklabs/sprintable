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

  it('⭐the notifications tab is ONE look: none of its cards imports an old `@/components/ui/…` part — they stand on the ds parts and the shared SettingsSection frame (PO 11-10: «the tab\'s half is old parts → not rebuilt»)', () => {
    const files = [
      join(__dirname, 'notifications-pane.tsx'),
      join(__dirname, '../../../components/settings/settings-section.tsx'),
      join(__dirname, '../../../components/settings/standup-deadline-section.tsx'),
      join(__dirname, '../../../components/settings/gate-level-matrix.tsx'),
      join(__dirname, '../../../components/settings/refresh-settings.tsx'),
      join(__dirname, '../../../components/settings/push-register-notice.tsx'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // reverted (a card back on ui/section-card · ui/button · ui/alert · ui/badge · ui/input …) → this names the file
      expect(src, `${f} imports an old ui/ part`).not.toMatch(/from '@\/components\/ui\//);
    }
    // the tab's own frame for the auto-refresh card is the shared one too
    const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    const tab = page.slice(page.indexOf('<TabsContent value="notifications">'), page.indexOf('</TabsContent>', page.indexOf('<TabsContent value="notifications">')));
    expect(tab).toContain('<SettingsSection');
    expect(tab).not.toContain('<SectionCard');
  });
});
