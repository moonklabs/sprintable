// story 4891 (UI-8 AC4 · first screen rebuild) — «every section that can be seen is in the list», as a test per combination of what decides it (role read · admin · phone app · support flag · billing flag).
// The expectation below is written out independently of `settingsNavGroups` (plain ifs, the page's old conditions) — a section dropped from a combination, or one the page cannot open drawn, turns this red.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsNavGroups, settingsNavTabIds, type SettingsNavGates } from './settings-nav';
import { HIDDEN_SETTINGS_TABS, resolveSettingsTab } from './settings-tab';

const combos: SettingsNavGates[] = [];
for (const adminChecked of [false, true]) for (const isAdmin of [false, true]) for (const inPhoneApp of [false, true]) for (const supportWidget of [false, true]) for (const billing of [false, true]) {
  combos.push({ adminChecked, isAdmin, inPhoneApp, supportWidget, billing });
}
const label = (g: SettingsNavGates) => JSON.stringify(g);

/** what a person can be on, written out from the page's old conditions (in the order the list draws them) */
function expectedTabs(g: SettingsNavGates): string[] {
  const ids = ['profile', 'appearance', 'notifications', 'desktop'];
  if (g.inPhoneApp) ids.push('this-phone');
  if (g.supportWidget) ids.push('support');
  if (g.adminChecked) {
    ids.push('members');
    if (g.isAdmin && !HIDDEN_SETTINGS_TABS.has('workflow')) ids.push('workflow');
    if (g.isAdmin) ids.push('workflow-policies');
    ids.push('organization');
    if (!HIDDEN_SETTINGS_TABS.has('org-members')) ids.push('org-members');
    ids.push('projects');
    if (g.isAdmin) { if (g.billing) ids.push('billing'); ids.push('usage'); }
  }
  ids.push('danger');
  return ids;
}

describe('settingsNavGroups — which sections the list draws (story 4891)', () => {
  for (const g of combos) {
    it(`⭐${label(g)}: exactly the sections that combination can open, in the page's order`, () => {
      expect(settingsNavTabIds(g)).toEqual(expectedTabs(g));
    });
  }

  it('⭐every section the list draws is one the page can actually open (a deep link to it lands on it, not on the default tab) — no dead row', () => {
    for (const g of combos) {
      for (const id of settingsNavTabIds(g)) {
        expect(resolveSettingsTab(id, { supportWidget: g.supportWidget, billing: g.billing, phoneApp: g.inPhoneApp }), `${id} in ${label(g)}`).toBe(id);
      }
    }
  });

  it('⭐every pane the page draws (a TabsContent) is in the list for some combination — a pane nobody can reach is a defect (the one exception is the old «api-keys» pane that only says the keys moved)', () => {
    const src = readFileSync(resolve(__dirname, 'page.tsx'), 'utf8');
    const panes = [...src.matchAll(/<TabsContent value="([a-z-]+)"/g)].map((m) => m[1]!);
    expect(panes.length).toBeGreaterThan(8);
    const reachable = new Set(combos.flatMap((g) => settingsNavTabIds(g)));
    const orphans = panes.filter((p) => !reachable.has(p) && !HIDDEN_SETTINGS_TABS.has(p) && p !== 'api-keys');
    expect(orphans).toEqual([]);
  });

  it('the groups keep the page\'s headings in order; «연동» is a link to another page (not a tab) and the danger row is last', () => {
    const groups = settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: false, supportWidget: false, billing: true });
    expect(groups.map((x) => x.labelKey)).toEqual(['myAccount', 'projectSettings', 'organizationSettings', 'billing', 'tabIntegrations', 'dangerZone']);
    expect(groups.find((x) => x.id === 'integrations')!.items).toEqual([expect.objectContaining({ kind: 'link', id: 'integrations' })]);
    expect(groups.at(-1)!.items).toEqual([expect.objectContaining({ id: 'danger', danger: true })]);
  });

  it('a person who is not an admin has no billing heading at all; before the role is read the role-bound groups show placeholder rows instead', () => {
    expect(settingsNavGroups({ adminChecked: true, isAdmin: false, inPhoneApp: false, supportWidget: false, billing: true }).some((x) => x.id === 'billing')).toBe(false);
    const pending = settingsNavGroups({ adminChecked: false, isAdmin: false, inPhoneApp: false, supportWidget: false, billing: true });
    expect(pending.find((x) => x.id === 'project')).toMatchObject({ items: [], pending: 2 + (HIDDEN_SETTINGS_TABS.has('workflow') ? 0 : 1) });
    expect(pending.find((x) => x.id === 'organization')).toMatchObject({ items: [], pending: 2 + (HIDDEN_SETTINGS_TABS.has('org-members') ? 0 : 1) });
    expect(pending.find((x) => x.id === 'billing')).toMatchObject({ items: [], pending: 2 });
  });
});
