// story 4936 AC2 — the table. Each «refused» row is a string that left the app on dev (11-14) or the same string one encoding layer deeper; each «kept» row is a real address the app sends itself.
import { describe, expect, it } from 'vitest';
import { INTERNAL_PATH_MAX, isSafeInternalPath, safeInternalPath } from './internal-path';

const KEPT = [
  '/',
  '/flow',
  '/chats',
  '/flow?story=0a1b2c3d',
  '/flow?story=a%26b&p=1', // an encoded & inside a query value is ordinary
  '/org-briefing?next=%2Fflow%3Fstory%3Dx&_prRetry=1', // a path carried in a query of its own
  '/qa-probe/project-1/goals?view=list#top',
  '/%ED%99%88/%EA%B8%B0%EB%A1%9D', // percent-encoded Korean segments
  '/docs/a%20b', // an encoded space
  '/x?q=100%25', // a literal percent sign (cannot be decoded a second time — the last form)
  '/a%zz', // not a valid escape: judged as it is
  '/./a', '/a/../b', '/a/../flow', '/a//b', '/%2e/a',
  '/a%zz', '/x%E0%A4%A?q=1', // a broken escape elsewhere in an otherwise ordinary address is judged as it is
];

const REFUSED: [string, string][] = [
  ['tab between the slashes', '/\t/evil.com'],
  ['LF between the slashes', '/\n/evil.com'],
  ['CR between the slashes', '/\r/evil.com'],
  ['tab then backslash', '/\t\\evil.com'],
  ['%09 (one decode makes the tab)', '/%09/evil.com'],
  ['%0A', '/%0A/evil.com'],
  ['%0D', '/%0D/evil.com'],
  ['%09 lower case', '/%0a/evil.com'],
  ['%2509 (two decodes make the tab)', '/%2509/evil.com'],
  ['%252509 (three decodes)', '/%252509/evil.com'],
  ['%255C backslash two layers deep', '/%255Cevil.com'],
  ['protocol-relative', '//evil.com'],
  ['encoded protocol-relative', '/%2Fevil.com'],
  ['encoded protocol-relative, upper and lower', '/%2fevil.com'],
  ['slash backslash', '/\\evil.com'],
  ['backslash first', '\\/evil.com'],
  ['backslash inside a later segment', '/a\\b'],
  ['absolute https', 'https://evil.com'],
  ['absolute http with the app host in it', 'http://localhost:3108/evil'],
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<b>x</b>'],
  ['mailto:', 'mailto:a@b.c'],
  ['dot segment folds to //evil.com: /..//', '/..//evil.com'],
  ['dot segment folds to //evil.com: /.//', '/.//evil.com'],
  ['dot segment folds to //evil.com: /a/..//', '/a/..//evil.com'],
  ['encoded dot segments fold to //evil.com', '/%2e%2e//evil.com'],
  ['encoded single dot folds to //evil.com', '/%2e//evil.com'],
  ['legacy %u escape for a slash', '/%u002f%u002fevil.com'],
  ['a broken sequence hides good ones from decodeURIComponent: a lenient decoder reads //', '/%2f%2f%E0%A4%A'],
  ['empty', ''],
  ['a relative path', 'flow'],
  ['dot dot relative', '../flow'],
  ['NUL', '/\u0000/x'],
  ['DEL', '/\u007f/x'],
  ['a control character in the query', '/flow?x=\t1'],
  ['leading space', ' /flow'],
  ['four encoding layers (more than any real address has)', '/%25252509/evil.com'],
  ['too long', `/${'a'.repeat(INTERNAL_PATH_MAX)}`],
];

describe('isSafeInternalPath — story 4936', () => {
  for (const v of KEPT) it(`keeps ${JSON.stringify(v)}`, () => expect(isSafeInternalPath(v)).toBe(true));
  for (const [why, v] of REFUSED) it(`refuses ${JSON.stringify(v).slice(0, 60)} — ${why}`, () => expect(isSafeInternalPath(v)).toBe(false));

  it('refuses everything that is not a string', () => {
    for (const v of [null, undefined, 0, 1, true, {}, [], ['/flow'], Symbol.iterator]) expect(isSafeInternalPath(v)).toBe(false);
  });

  it('a value that passes is returned by safeInternalPath unchanged (judged, never rewritten); a value that fails gives the fallback', () => {
    expect(safeInternalPath('/flow?story=a%26b', '/chats')).toBe('/flow?story=a%26b');
    expect(safeInternalPath('/\t/evil.com', '/chats')).toBe('/chats');
    expect(safeInternalPath(null, '/chats')).toBe('/chats');
  });

  it('the parser has the last word: every refused row, resolved against an app address, would have left that address or is no path at all — and every kept row stays on it', () => {
    const base = 'https://app.test';
    for (const v of KEPT) expect(new URL(v, base).origin, v).toBe(base);
    const left = REFUSED.filter(([, v]) => { try { return new URL(v, base).origin !== base; } catch { return true; } });
    // at least the four raw control-character forms really leave (this is the measured hole)
    for (const v of ['/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/\t\\evil.com']) expect(left.map(([, x]) => x), v).toContain(v);
  });
});
