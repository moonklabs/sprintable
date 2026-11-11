// story 4891 (PO 11-11) — the first screen of the onboarding (the Mac / not-Mac face and its «고급» web way) draws only ds parts: no old `ui/` import in its two files (named exception: the read-only textarea of the copy-failed fallback has no ds twin).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = __dirname;
const IMPORT_RE = /from\s+['"](@\/components\/ui\/[^'"]+)['"]/g;
const EXEMPT = new Set(['@/components/ui/textarea']);

describe('onboarding first screen on ds parts', () => {
  for (const file of ['first-screen.tsx', 'advanced-connect.tsx']) {
    it(`${file}: no old ui/ part imported (except the textarea)`, () => {
      const src = readFileSync(path.join(here, file), 'utf8');
      const olds = [...src.matchAll(IMPORT_RE)].map((m) => m[1]!).filter((s) => !EXEMPT.has(s));
      expect(olds).toEqual([]);
    });
  }
  it('the two press words that were small links are ds buttons / 44 rows (the way out is a ds quiet button; «앱 열기» and «고급» carry min-h-11)', () => {
    const src = readFileSync(path.join(here, 'first-screen.tsx'), 'utf8');
    expect(src).toMatch(/import \{ Button \} from '@\/components\/ds\/button'/);
    expect(src.match(/variant="quiet"/g)?.length).toBe(2);
    expect(src).toMatch(/data-testid="onboarding-first-open-app"/);
    expect(src.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
