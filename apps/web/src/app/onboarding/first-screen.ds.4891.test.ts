// story 4891 (PO 11-11) · story 5036 — the first screen of the onboarding (step ②: the three ways) and the steps around it (① the project · ③ the first conversation) draw only ds parts: no old `ui/` import in their files (named exception: the read-only textarea of the copy-failed fallback has no ds twin).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = __dirname;
const IMPORT_RE = /from\s+['"](@\/components\/ui\/[^'"]+)['"]/g;
const EXEMPT = new Set(['@/components/ui/textarea']);

describe('onboarding first screen on ds parts', () => {
  for (const file of ['first-screen.tsx', 'advanced-connect.tsx', 'connect-branches.tsx', 'project-step.tsx', 'first-chat-step.tsx']) {
    it(`${file}: no old ui/ part imported (except the textarea)`, () => {
      const src = readFileSync(path.join(here, file), 'utf8');
      const olds = [...src.matchAll(IMPORT_RE)].map((m) => m[1]!).filter((s) => !EXEMPT.has(s));
      expect(olds).toEqual([]);
    });
  }
  it('the way out is a ds quiet button; the two app ways\' «앱 열기» are ds buttons too (a link in a ds Button — it carries the 44 floor on touch, not a hand-written min-h)', () => {
    const src = readFileSync(path.join(here, 'first-screen.tsx'), 'utf8');
    expect(src).toMatch(/import \{ Button \} from '@\/components\/ds\/button'/);
    expect(src.match(/variant="quiet"/g)?.length).toBe(3); // the browser's way out + the phone app's + story 5024 (AC4)'s server-host way (the same ds quiet button)
    const ways = readFileSync(path.join(here, 'connect-branches.tsx'), 'utf8');
    expect(ways).toMatch(/import \{ Button \} from '@\/components\/ds\/button'/);
    expect(ways.match(/<Button asChild/g)?.length).toBe(1); // one element for both app ways (new · move), the same ds button
    expect(ways).toMatch(/data-testid=\{`connect-branch-\$\{id\}-open`\}/);
    expect(ways).not.toMatch(/<details/); // story 5036: no «고급» fold
  });
});
