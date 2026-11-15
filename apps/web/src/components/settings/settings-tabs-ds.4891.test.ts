// story 4891 (UI-8 · settings pieces ③ …) — for each settings tab that stands on the ds parts: no old `@/components/ui/*` part anywhere in what the tab draws (import walk from its roots, named exceptions in
// the helper), and every component the page's `<TabsContent>` names for the tab is one of the roots (a new one added there must be added here). Pieces add their tab below.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IMPORT_RE, SRC, componentFile, namedComponents, pageImportSource, tabBlock, walkOldUi } from './settings-tab-walk.helper';

/** tab value → { the components its block names in page.tsx → its file under components/ (without .tsx) } */
const TABS: Record<string, Record<string, string>> = {
  appearance: { ThemeSettings: 'settings/theme-settings', LanguageSettings: 'settings/language-settings' },
  'this-phone': { ThisPhoneCard: 'settings/this-phone-card' },
  desktop: { DesktopDownloadCard: 'desktop/desktop-download-card', PhoneAppCard: 'desktop/phone-app-card' },
  members: { ProjectAccessSection: 'settings/project-access-section', MemberWebhooksSection: 'settings/member-webhooks-section' },
  'org-members': { OrgMembersSection: 'settings/org-members-section' }, // the remove dialog is reached through its imports
  organization: { OrganizationSection: 'settings/organization-section', OrgDangerSection: 'settings/organization-section', GateLevelMatrix: 'settings/gate-level-matrix', OrgGatePolicySection: 'settings/org-gate-policy-section' },
  // story 4891 (settings frame + four tabs)
  support: { SupportSettingsTabPanel: 'settings/support-tab-panel' }, // the chat body is reached through its imports
  'api-keys': { ApiKeysMovedCard: 'settings/api-keys-moved-card' },
  projects: { ProjectsSection: 'settings/projects-section' }, // the page keeps the state and the requests; the part draws
  danger: { AccountDangerSection: 'settings/account-danger-section' },
  // story 4891 (second piece)
  'workflow-policies': { WorkflowLineEditorSection: 'settings/workflow-line-editor-section' }, // the active-line view and the simulator are reached through its imports
};

/** tabs whose block in page.tsx also draws JSX of its own (not only components): every capitalised name there must come from a ds part (or the settings frame / parts), and the block must hold no hand-drawn old pieces */
const INLINE: Record<string, string[]> = {
  'org-members': ['Skeleton', 'SkeletonGroup'],
  members: ['DsButton', 'Plus'], // the «멤버 추가» button and its lucide icon
  'workflow-policies': ['SettingsSection'], // the card frame around the line editor
};
const OLD_PIECES = /animate-pulse|<input\b|<select\b|<button\b|<label\b|\btext-(xs|sm)\b|text-muted-foreground|text-foreground|text-destructive|<Alert\b|<SectionCard/;

describe('settings tabs on ds parts: nothing old in what they draw', () => {
  it('the walk reads double-quoted, side-effect and dynamic imports too', () => {
    const found = [...`import { A } from "@/components/ui/a";\nimport '@/components/ui/b';\nconst C = lazy(() => import('@/components/ui/c'));\nexport * from './d';`.matchAll(IMPORT_RE)].map((m) => m[1]);
    expect(found).toEqual(['@/components/ui/a', '@/components/ui/b', '@/components/ui/c', './d']);
  });
  for (const [tab, comps] of Object.entries(TABS)) {
    it(`tab «${tab}»: no old ui/ part in what it draws, and the page names no component the walk does not start from`, () => {
      const { seen, olds } = walkOldUi(Object.values(comps).map(componentFile));
      expect(seen.length, 'the walk went no further than the roots (it should follow their imports, e.g. settings-section)').toBeGreaterThan(Object.keys(comps).length);
      expect(olds, `old ui/ imports in tab «${tab}»:\n${olds.join('\n')}`).toEqual([]);
      const block = tabBlock(tab);
      const inline = INLINE[tab] ?? [];
      const named = namedComponents(block);
      expect(named.filter((n) => !(n in comps) && !inline.includes(n)), `components the «${tab}» tab draws that the walk does not start from`).toEqual([]);
      expect(named.filter((n) => n in comps).length).toBe(Object.keys(comps).length);
      for (const n of inline) {
        const from = pageImportSource(n);
        expect(from, `${n} (used inline in the «${tab}» tab) is imported from a ds part / the settings parts`).toMatch(/^(@\/components\/(ds\/|settings\/settings-(section|parts))|lucide-react$)/);
      }
      expect(block.match(OLD_PIECES)?.[0] ?? null, `the «${tab}» tab block still draws an old piece`).toBeNull();
    });
  }

  it('the «멤버 추가» dialog (opened from the members tab, rendered by the page outside the tab block) has no old ui/ part either', () => {
    const { olds } = walkOldUi([componentFile('settings/add-member-modal')]);
    expect(olds, `old ui/ imports in the add-member dialog:\n${olds.join('\n')}`).toEqual([]);
  });

  // story 4891 — the confirmations the page renders outside any tab block (opened from the organization · projects · account panes)
  for (const dialog of ['settings/delete-account-dialog', 'settings/org-delete-dialog', 'settings/project-delete-dialog']) {
    it(`the confirmation «${dialog}» has no old ui/ part`, () => {
      const { olds } = walkOldUi([componentFile(dialog)]);
      expect(olds, `old ui/ imports in ${dialog}:\n${olds.join('\n')}`).toEqual([]);
    });
  }
});

// story 4891 — the settings FRAME (settings/page.tsx itself, outside every tab block): which old `ui/` parts the page still imports. Exactly two are left, each named with its reason; a third one, or a leftover of any tab's own, fails here.
describe('the settings frame (page.tsx): the old ui/ parts it still imports are the named ones', () => {
  const page = readFileSync(path.join(SRC, 'app', '(authenticated)', 'settings', 'page.tsx'), 'utf8');
  const olds = [...page.matchAll(IMPORT_RE)].map((m) => m[1]!).filter((spec) => /^@\/components\/ui\//.test(spec)).sort();
  it('only the Tabs mechanism (a vertical list + panels — ds Tabs is the horizontal kind and carries no panel text size the untouched tabs rely on) and the toast hook', () => {
    expect(olds).toEqual(['@/components/ui/tabs', '@/components/ui/toast']);
  });
  it('the page draws no hand-made old piece: no <Button>/<Dialog>/<Alert>/<Badge>/<OperatorInput>/<input>/<select>/<button> of its own', () => {
    expect(page.match(/<(Button|Dialog|DialogContent|Alert|Badge|OperatorInput|input|select|button)\b/)?.[0] ?? null).toBeNull();
  });
});
