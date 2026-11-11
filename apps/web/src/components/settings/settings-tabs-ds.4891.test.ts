// story 4891 (UI-8 · settings pieces ③ …) — for each settings tab that stands on the ds parts: no old `@/components/ui/*` part anywhere in what the tab draws (import walk from its roots, named exceptions in
// the helper), and every component the page's `<TabsContent>` names for the tab is one of the roots (a new one added there must be added here). Pieces add their tab below.
import { describe, expect, it } from 'vitest';
import { IMPORT_RE, componentFile, namedComponents, tabBlock, walkOldUi } from './settings-tab-walk.helper';

/** tab value → { the components its block names in page.tsx → its file under components/ (without .tsx) } */
const TABS: Record<string, Record<string, string>> = {
  appearance: { ThemeSettings: 'settings/theme-settings', LanguageSettings: 'settings/language-settings' },
  'this-phone': { ThisPhoneCard: 'settings/this-phone-card' },
  desktop: { DesktopDownloadCard: 'desktop/desktop-download-card', PhoneAppCard: 'desktop/phone-app-card' },
};

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
      const named = namedComponents(tabBlock(tab));
      expect(named.filter((n) => !(n in comps)), `components the «${tab}» tab draws that the walk does not start from`).toEqual([]);
      expect(named.length).toBe(Object.keys(comps).length);
    });
  }
});
