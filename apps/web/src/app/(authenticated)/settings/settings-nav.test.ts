// story 4891 (UI-8 AC4 · first screen rebuild) — «every section that can be seen is in the list», as a test per combination of what decides it (role read · admin · phone app · support flag · billing flag).
// The expectation below is written out independently of `settingsNavGroups` (plain ifs, the page's old conditions) — a section dropped from a combination, or one the page cannot open drawn, turns this red.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsNavGroups, settingsNavTabIds, type SettingsNavGates } from './settings-nav';
import { HIDDEN_SETTINGS_TABS, resolveSettingsTab } from './settings-tab';
import { allNavItems } from '@/lib/nav-config';
import { ROUTE_PLACEMENT } from '@/lib/nav-placement';
import { navItemRoute } from '@/lib/nav-depth1';

const combos: SettingsNavGates[] = [];
for (const adminChecked of [false, true]) for (const isAdmin of [false, true]) for (const inPhoneApp of [false, true]) for (const supportWidget of [false, true]) for (const billing of [false, true]) {
  combos.push({ adminChecked, isAdmin, inPhoneApp, supportWidget, billing });
}
const label = (g: SettingsNavGates) => JSON.stringify(g);

/** what a person can be on, written out from the conditions (in the order the list draws them) — story 5037: 내 계정 · 조직 · 사람과 역할 · 연결 · 프로젝트 관리 · 콘텐츠 규칙 · 청구 · 모양 · 위험 */
function expectedTabs(g: SettingsNavGates): string[] {
  const ids = ['profile', 'notifications', 'desktop'];
  if (g.inPhoneApp) ids.push('this-phone');
  if (g.supportWidget) ids.push('support');
  if (g.adminChecked) {
    ids.push('organization');
    if (!HIDDEN_SETTINGS_TABS.has('org-members')) ids.push('org-members');
    ids.push('members');
    ids.push('projects');
    if (g.isAdmin && !HIDDEN_SETTINGS_TABS.has('workflow')) ids.push('workflow');
    if (g.isAdmin) ids.push('workflow-policies');
    if (g.isAdmin) { if (g.billing) ids.push('billing'); ids.push('usage'); }
  }
  ids.push('appearance');
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

  it('⭐story 5037: the groups are 내 계정 · 조직 · 사람과 역할 · 연결 · 프로젝트 관리 · 콘텐츠 규칙 · 청구 · 모양 · 위험, in that order; «연동» is still a link (not a tab) and the danger row is last', () => {
    const groups = settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: false, supportWidget: false, billing: true });
    expect(groups.map((x) => x.labelKey)).toEqual(['myAccount', 'organizationSettings', 'groupPeopleRoles', 'groupConnections', 'groupProjectManagement', 'groupContentRules', 'billing', 'groupAppearance', 'dangerZone']);
    expect(groups.find((x) => x.id === 'connections')!.items[0]).toEqual(expect.objectContaining({ kind: 'link', id: 'integrations' }));
    expect(groups.at(-1)!.items).toEqual([expect.objectContaining({ id: 'danger', danger: true })]);
  });

  it('a person who is not an admin has no billing heading at all; before the role is read the role-bound groups show placeholder rows instead', () => {
    expect(settingsNavGroups({ adminChecked: true, isAdmin: false, inPhoneApp: false, supportWidget: false, billing: true }).some((x) => x.id === 'billing')).toBe(false);
    const pending = settingsNavGroups({ adminChecked: false, isAdmin: false, inPhoneApp: false, supportWidget: false, billing: true });
    expect(pending.find((x) => x.id === 'project')).toMatchObject({ items: [], pending: 2 + (HIDDEN_SETTINGS_TABS.has('workflow') ? 0 : 1) });
    expect(pending.find((x) => x.id === 'organization')).toMatchObject({ items: [], pending: 1 + (HIDDEN_SETTINGS_TABS.has('org-members') ? 0 : 1) });
    expect(pending.find((x) => x.id === 'billing')).toMatchObject({ items: [], pending: 2 });
  });
});

describe('[SID:4994] the «this phone» tab in the guest desktop app (a COMPUTER)', () => {
  it('is «이 컴퓨터» with the desktop icon in the guest app, and unchanged (smartphone · «이 폰») in a phone and without a device kind', () => {
    const find = (deviceKind?: 'phone' | 'computer') => settingsNavGroups({ adminChecked: false, isAdmin: false, inPhoneApp: true, supportWidget: false, billing: false, ...(deviceKind ? { deviceKind } : {}) })
      .flatMap((g) => g.items).find((i) => i.kind === 'tab' && i.id === 'this-phone');
    expect(find('computer')).toMatchObject({ labelKey: 'tabThisComputer', icon: 'desktop_windows' });
    expect(find('phone')).toMatchObject({ labelKey: 'tabThisPhone', icon: 'smartphone' });
    expect(find()).toMatchObject({ labelKey: 'tabThisPhone', icon: 'smartphone' });
  });
});


describe('[SID:5037] C7 — nothing is dropped: the old addresses and the organization screens', () => {
  /** every tab id the settings list could open before this story (the old `?tab=` addresses) — a bookmark, a notification link or a doc that holds one must still land on its pane */
  const OLD_TAB_IDS = ['profile', 'appearance', 'notifications', 'desktop', 'this-phone', 'support', 'members', 'workflow', 'workflow-policies', 'organization', 'org-members', 'projects', 'billing', 'usage', 'danger'];

  it('⭐every old tab id is still a row of some combination (or is switched off on purpose) and its address still opens it', () => {
    const reachable = new Set(combos.flatMap((g) => settingsNavTabIds(g)));
    for (const id of OLD_TAB_IDS) {
      if (HIDDEN_SETTINGS_TABS.has(id)) continue;
      expect(reachable.has(id), `${id} lost its row`).toBe(true);
      expect(resolveSettingsTab(id, { supportWidget: true, billing: true, phoneApp: true }), `${id} no longer opens`).toBe(id);
    }
  });

  it('⭐every link row that names a screen names one the nav catalog has (a static screen) — no dead door', () => {
    const catalog = allNavItems();
    const navIds = settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: true, supportWidget: true, billing: true }).flatMap((grp) => grp.items).filter((i) => i.kind === 'link' && i.navId).map((i) => i.navId!);
    expect(navIds.length).toBeGreaterThan(0);
    for (const id of navIds) expect(catalog.some((c) => c.id === id && c.kind === 'static'), id).toBe(true);
  });

  it('⭐every organization screen the placement table puts in 설정 has a link row here (빠짐 0) — and each sits in the group its row of the table names (연결 · 사람과 역할 · 콘텐츠 규칙)', () => {
    const groups = settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: false, supportWidget: false, billing: true });
    const where = new Map<string, string>();
    for (const grp of groups) for (const i of grp.items) if (i.kind === 'link' && i.navId) where.set(i.navId, grp.id);
    const inSettings = allNavItems().filter((c) => c.kind === 'static' && c.path.startsWith('/organization/') && ROUTE_PLACEMENT[navItemRoute(c)]?.slot === 'settings');
    expect(inSettings.map((c) => c.id).sort()).toEqual(['org-channels', 'org-content-rules', 'org-events', 'org-generation-connectors', 'org-members', 'org-roles']);
    for (const c of inSettings) expect(where.has(c.id), `${c.id} has no door in settings`).toBe(true);
    expect(Object.fromEntries(where)).toEqual({ 'org-members': 'people', 'org-roles': 'people', 'org-channels': 'connections', 'org-generation-connectors': 'connections', 'org-events': 'connections', 'org-content-rules': 'content-rules' });
  });

  it('a link row that names a catalog screen is named by that screen\'s own label (one thing, one word) — the settings list never invents a second name', () => {
    const catalog = allNavItems();
    for (const grp of settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: false, supportWidget: false, billing: true })) {
      for (const i of grp.items) if (i.kind === 'link' && i.navId) {
        expect(i.ns, i.id).toBe('nav');
        expect(catalog.find((c) => c.id === i.navId)!.labelKey, i.id).toBe(i.labelKey);
      }
    }
  });
});
