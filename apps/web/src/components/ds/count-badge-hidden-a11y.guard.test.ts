// story #3518 (유나 #3861) → 4890 (UI-7 겸사): the icon-corner count overlay used to be its own part (`ui/corner-count-badge`, a 10 px badge — below the 12 px floor); it is the one ds `CountBadge` now (11 px mono, the named exception).
// The contract did not change: a badge drawn on an icon is `aria-hidden`, so the NUMBER reaches assistive tech through the nearest accessible name — the button/link's `aria-label` (icon-only: bell · presence) or an `sr-only` text appended after the visible
// label (the tab bar — WCAG 2.5.3: the visible label must stay in the name). A new consumer that hides its badge and forgets the wiring silently loses the number for screen-reader users: this guard catches that (the most common regression).
// It reads each `<CountBadge … aria-hidden …>` tag and looks around it (±WINDOW_CHARS) for `aria-label` or `sr-only`; precise names are the consumers' own render tests (notification-bell · mobile-tab-bar-badge).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '../../');
const WINDOW_CHARS = 800;
const MARKERS = ['aria-label', 'sr-only'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/** every `<CountBadge … />` opening tag that carries `aria-hidden` (the tag text runs to its own `/>`) */
function hiddenBadgeUsages(content: string): number[] {
  const at: number[] = [];
  const re = /<CountBadge\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const end = content.indexOf('/>', m.index);
    if (end !== -1 && /\baria-hidden\b/.test(content.slice(m.index, end))) at.push(m.index);
  }
  return at;
}

const consumers = listSourceFiles(SRC_ROOT)
  .map((f) => ({ file: f, content: readFileSync(f, 'utf-8') }))
  .filter(({ content }) => hiddenBadgeUsages(content).length > 0);

describe('hidden CountBadge — the number reaches the accessible name (story #3518)', () => {
  it('the scan is not dead (a guard that finds nothing passes forever)', () => {
    expect(consumers.length).toBeGreaterThan(0);
  });

  it('exactly the four places that hide their badge (the three icon overlays + the «전체» shortcut row) — a new one: add it here and read its wiring', () => {
    expect(consumers.map(({ file }) => file.replace(SRC_ROOT, '')).sort()).toEqual([
      'app/(authenticated)/more/page.tsx',
      'components/nav/mobile-tab-bar.tsx',
      'components/nav/notification-bell.tsx',
      'components/presence/team-presence-toggle.tsx',
    ]);
  });

  for (const { file, content } of consumers) {
    it(`${file.replace(SRC_ROOT, '')} — each hidden badge has an accessible-name wiring (aria-label or sr-only) within ${WINDOW_CHARS} characters`, () => {
      for (const index of hiddenBadgeUsages(content)) {
        const around = content.slice(Math.max(0, index - WINDOW_CHARS), Math.min(content.length, index + WINDOW_CHARS));
        expect(MARKERS.some((mk) => around.includes(mk))).toBe(true);
      }
    });
  }

  it('the detector sees a hidden badge and ignores a visible one', () => {
    expect(hiddenBadgeUsages('<CountBadge count={3} aria-hidden className="x" />').length).toBe(1);
    expect(hiddenBadgeUsages('<CountBadge count={3} className="x" />').length).toBe(0);
  });
});
