// @vitest-environment jsdom
//
// story 4891 (UI-8 AC4 · first screen rebuild) — the settings list drawn with the ds parts. Structure pinned so a shrink back to the old 10px headings / 32px rows is red: every row is a ListRow (min height 56 — over the 44 a thumb
// needs), every heading a SectionHeader (an h2 at 14px — the old ones were text-[10px]), the selected row is the one `aria-current` / `aria-selected` marks, a row press calls onSelect, the link row goes to its page.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { Tabs } from '@/components/ui/tabs';
import { SettingsNav } from './settings-nav-list';
import { settingsNavGroups } from './settings-nav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const gates = { adminChecked: true, isAdmin: true, inPhoneApp: true, supportWidget: true, billing: true };
async function draw(activeTab: string, onSelect: (t: string) => void = () => {}, g = gates) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <Tabs value={activeTab} onValueChange={onSelect} orientation="vertical">
          <SettingsNav groups={settingsNavGroups(g)} activeTab={activeTab} integrationsHref="/settings/integrations" />
        </Tabs>
      </NextIntlClientProvider>,
    );
  });
}
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-slot="ds-list-row"]'));

describe('SettingsNav — drawn with the ds parts (story 4891)', () => {
  it('⭐every section is a ListRow (min height 56) and the tab rows are role=tab buttons, one per section', async () => {
    await draw('profile');
    expect(rows().length).toBe(settingsNavGroups(gates).flatMap((x) => x.items).length);
    for (const r of rows()) expect(r.className).toContain('min-h-ds-row');
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((t) => t.getAttribute('data-settings-tab'))).toEqual(settingsNavGroups(gates).flatMap((x) => x.items).filter((i) => i.kind === 'tab').map((i) => i.id));
  });

  it('⭐every group has a heading, drawn as a SectionHeader (an h2 · not the old 10px label) — including «연동» (one row with the heading\'s own name, as before: a person who moves by headings must find it)', async () => {
    await draw('profile');
    const heads = Array.from(container.querySelectorAll('[data-slot="ds-section-header"] h2')).map((h) => h.textContent?.trim());
    expect(heads).toEqual([koMessages.settings.myAccount, koMessages.settings.projectSettings, koMessages.settings.organizationSettings, koMessages.settings.billing, koMessages.settings.tabIntegrations, koMessages.settings.dangerZone]);
  });

  it('the selected section is the one marked (aria-selected + aria-current), only one', async () => {
    await draw('notifications');
    const selected = Array.from(container.querySelectorAll('[role="tab"][aria-selected="true"]'));
    expect(selected.map((s) => s.textContent?.trim())).toEqual([koMessages.settings.tabNotifications]);
    expect(container.querySelectorAll('[aria-current="true"]').length).toBe(1);
  });

  it('pressing a row selects that section; the «연동» row is a link to its page; the danger row reads in the failed colour', async () => {
    const onSelect = vi.fn();
    await draw('profile', onSelect);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-tab="appearance"]')!.click(); });
    expect(onSelect).toHaveBeenCalledWith('appearance', expect.anything());
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes(koMessages.settings.tabIntegrations));
    expect(link?.getAttribute('href')).toBe('/settings/integrations');
    expect(container.querySelector('[data-settings-tab="danger"] span')?.className).toContain('text-ds-failed');
  });

  it('while the role is being read the role-bound groups draw placeholder rows (same testid as before)', async () => {
    await draw('profile', () => {}, { ...gates, adminChecked: false });
    expect(container.querySelectorAll('[data-testid="settings-tab-skeleton"]').length).toBeGreaterThan(3);
  });

  it('⭐no old small-heading / old colour classes in the list file (text-[10px] · muted-foreground)', () => {
    const src = readFileSync(resolve(__dirname, 'settings-nav-list.tsx'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/text-\[(?:9|10|11)px\]|muted-foreground|text-foreground|bg-muted/);
  });
});
