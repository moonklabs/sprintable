// story 4780 (ratchet) — the phone's pairing screen is entered only through `usePairHref` (which hands the page over for [Close]); a new link that writes `/desktop/pair` itself would bring the person
// back to the Mac screen again. No code file outside lib/pair-return.ts · hooks/use-pair-href.ts names the address in a string (comments ignored).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations } from './nav-v3-destinations';
import { safeReturnPath } from './pair-return';

const SRC = resolve(__dirname, '..'); // apps/web/src
const OWNERS = new Set([['lib', 'pair-return.ts'].join(sep), ['hooks', 'use-pair-href.ts'].join(sep)]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}
const NAMES_THE_PAIR_SCREEN = /(['"`])(?:(?!\1)[^\n])*\/desktop\/pair(?:(?!\1)[^\n])*\1/;

export function pairScreenNamers(files: Array<{ path: string; source: string }>): string[] {
  return files.filter((f) => !OWNERS.has(f.path) && NAMES_THE_PAIR_SCREEN.test(stripComments(f.source))).map((f) => f.path);
}

function sourceFiles(dir: string, out: Array<{ path: string; source: string }> = []): Array<{ path: string; source: string }> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push({ path: relative(SRC, full), source: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('[SID:4780] the pairing screen is entered only through usePairHref', () => {
  const tree = sourceFiles(SRC);
  it('the tree walked is the app, and the five entries use the hook', () => {
    expect(tree.length).toBeGreaterThan(500);
    for (const p of ['components/org-briefing/today-pair-card.tsx', 'components/chat/agent-session-strip.tsx', 'components/inbox/agent-permission-requests.tsx', 'components/desktop/phone-first-screen.tsx', 'components/desktop/phone-pairing.tsx']) {
      expect(tree.find((f) => f.path.split('/').join(sep) === p.split('/').join(sep))?.source).toContain('usePairHref');
    }
  });
  it('no other file writes the pairing screen\'s address in a string — a new entry that does fails here', () => {
    expect(pairScreenNamers(tree)).toEqual([]); // reverted (an entry back to flat('/desktop/pair')) → that file is listed
  });
  it('the scanner itself: it sees a link, a template and a flat() argument; it ignores a comment and the owners', () => {
    const f = (path: string, source: string) => ({ path, source });
    expect(pairScreenNamers([f('a.tsx', "<a href={flat('/desktop/pair')}>x</a>")])).toEqual(['a.tsx']);
    expect(pairScreenNamers([f('b.tsx', 'const h = `/desktop/pair?x=1`;')])).toEqual(['b.tsx']);
    expect(pairScreenNamers([f('c.ts', '// the /desktop/pair screen\nconst x = 1;')])).toEqual([]);
    expect(pairScreenNamers([f(['lib', 'pair-return.ts'].join(sep), "return '/desktop/pair';")])).toEqual([]);
  });
});

// story 4780 (the sweep after the phone lap found Today's card on a screen the allow-list did not name): every screen that hosts a pairing entry must be a way back, or its [Close] goes to the Mac screen.
// The table ties each entry to the screen file that draws it and to the address that screen has; the Today screen's address comes from the same resolver the app uses.
describe('[SID:4780] every screen that hosts a pairing entry is a way back', () => {
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
  const todayOff = resolveNavV3Destinations(DEFAULT_NAV_V3_FLAGS).today.path;
  const todayOn = resolveNavV3Destinations({ ...DEFAULT_NAV_V3_FLAGS, todayV3Enabled: true }).today.path;
  const HOSTS: Array<{ entry: string; drawnBy: Array<[string, string]>; route: string }> = [
    // [file that draws it, tag it draws] → the route of the screen
    { entry: 'Today card', drawnBy: [['components/org-briefing/org-briefing-shell.tsx', '<TodayPairCard'], ['app/(authenticated)/org-briefing/page.tsx', '<OrgBriefingShell']], route: todayOff },
    { entry: 'inbox', drawnBy: [['app/(authenticated)/inbox/page.tsx', '<AgentPermissionRequests']], route: '/inbox' },
    { entry: 'chat head', drawnBy: [['app/(authenticated)/chats/[conversation_id]/page.tsx', '<AgentSessionStrip']], route: '/chats/0f3c2a1e-1111-4222-8333-944455556666' },
    { entry: '원격 기기', drawnBy: [['components/desktop/desktop-remote-devices.tsx', '<PhonePairEntry'], ['app/(authenticated)/desktop/page.tsx', '<DesktopRemoteDevices']], route: '/desktop' },
    { entry: 'phone start screen', drawnBy: [['components/desktop/phone-start-page.tsx', '<PhoneFirstScreen'], ['app/phone-start/page.tsx', 'PhoneStartPage']], route: '/phone-start' },
  ];
  it.each(HOSTS)('$entry is drawn on $route, and that address is a way back', ({ drawnBy, route }) => {
    for (const [file, tag] of drawnBy) expect(read(file), `${file} draws ${tag}`).toContain(tag); // the table is true: a moved entry fails here first
    expect(safeReturnPath(route), route).toBe(route); // reverted (the Today address missing from the allow-list) → null
  });
  it('Today is a way back whichever way TODAY_V3 is set', () => {
    expect([todayOff, todayOn]).toEqual(['/org-briefing', '/today']);
    for (const path of [todayOff, todayOn]) expect(safeReturnPath(path)).toBe(path);
  });
  it('the sign-up screen hands over the server\'s Today address instead of coming back to itself', () => {
    expect(read('app/onboarding/onboarding-form.tsx')).toContain('todayHref={todayHref}');
    expect(read('app/onboarding/first-screen.tsx')).toContain('returnHref={todayHref}');
    expect(read('components/desktop/phone-first-screen.tsx')).toContain('usePairHref(returnHref)');
  });
});
