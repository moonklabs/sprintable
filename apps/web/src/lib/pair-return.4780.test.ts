// story 4780 — the way back handed to the phone's pairing screen: an address anybody can write, so only the app's own few phone screens are taken (AC2: no open redirect)
import { describe, expect, it } from 'vitest';
import { PAIR_RETURN_PARAM, pairReturnQuery, safeReturnPath } from './pair-return';

describe('[SID:4780] safeReturnPath', () => {
  it.each([
    ['/today', '/today'],
    ['/today?p=proj-1', '/today?p=proj-1'],
    ['/inbox', '/inbox'],
    ['/inbox?tab=gates&p=proj-1', '/inbox?p=proj-1'], // only the project of the query is kept
    ['/desktop', '/desktop'],
    ['/phone-start', '/phone-start'],
    ['/chats', '/chats'],
    ['/chats/0f3c2a1e-1111-4222-8333-944455556666', '/chats/0f3c2a1e-1111-4222-8333-944455556666'],
    ['/organization/workforce/agent_1', '/organization/workforce/agent_1'],
    ['/today/', '/today/'],
    ['/org-briefing', '/org-briefing'], // Today when TODAY_V3 is off (the Today card lives on this screen)
    ['/org-briefing?focus=compose&p=proj-1', '/org-briefing?p=proj-1'],
    ['/org-briefing/', '/org-briefing/'],
  ])('takes %s → %s', (given, want) => {
    expect(safeReturnPath(given)).toBe(want);
  });

  it.each([
    ['an address outside the app', 'https://evil.example/today'],
    ['a protocol-relative address', '//evil.example/today'],
    ['a backslash made into a host', '/\\evil.example'],
    ['a scheme', 'javascript:alert(1)'],
    ['a relative path', 'today'],
    ['the pairing screen itself (a loop)', '/desktop/pair'],
    ['a deeper path of an allowed screen', '/desktop/setup'],
    ['an organization-prefixed path (this or another org)', '/moonklabs/sprintable/board'],
    ['an api path', '/api/auth/logout'],
    ['an organization-prefixed copy of an allowed screen', '/moonklabs/sprintable/inbox'],
    ['the login screen', '/login?next=/today'],
    ['a screen that redirects on its own parameter', '/onboarding?next=//evil.example'],
    ['an encoded second slash', '/%2Fevil.example'],
    ['a newline', '/today\n/evil'],
    ['a tab in the path', '/today\t'],
    ['empty', ''],
    ['too long (a long query on an allowed screen)', `/today?p=${'a'.repeat(600)}`],
    ['a path traversal out of the allowed set', '/today/../api/x'],
    ['a deeper path of the Today screen', '/org-briefing/x'],
    ['a look-alike prefix', '/org-briefingx'],
    ['an organization-prefixed copy of the Today screen', '/moonklabs/sprintable/org-briefing'],
    ['an encoded slash after the Today screen', '/org-briefing%2F..%2Fapi%2Flogout'],
    ['the sign-up screen itself (it is a place to leave, not a way back)', '/onboarding'],
    ['a scheme before the Today screen', 'https://evil.example/org-briefing'],
    ['a protocol-relative copy of the Today screen', '//evil.example/org-briefing'],
  ])('drops %s', (_why, given) => {
    expect(safeReturnPath(given)).toBeNull();
  });

  it('a value that is not a string is dropped', () => {
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(['/today'])).toBeNull();
    expect(safeReturnPath(42)).toBeNull();
  });

  it('another parameter of the query never survives (next · return · a second p is read as the first)', () => {
    expect(safeReturnPath('/today?next=https://evil.example&return=//x&p=a&p=b')).toBe('/today?p=a');
  });
});

describe('[SID:4780] pairReturnQuery', () => {
  it('carries the page the link stands on as `from`', () => {
    expect(pairReturnQuery('/today?p=proj-1')).toBe(`?${PAIR_RETURN_PARAM}=${encodeURIComponent('/today?p=proj-1')}`);
    expect(pairReturnQuery('/inbox')).toBe('?from=%2Finbox');
  });
  it('a way back the page knows better than its own address wins (the sign-up screen: Today, from the server\'s nav flags); another parameter of it never survives', () => {
    expect(pairReturnQuery('/onboarding', '/org-briefing')).toBe('?from=%2Forg-briefing');
    expect(pairReturnQuery('/onboarding', '/today')).toBe('?from=%2Ftoday');
    expect(pairReturnQuery('/inbox?p=a', '/org-briefing')).toBe('?from=%2Forg-briefing'); // the page IS a return target itself, yet the way back it was handed wins — reverted (the page's address first) → '?from=%2Finbox%3Fp%3Da'
    expect(pairReturnQuery('', '/org-briefing?next=//x&p=a')).toBe('?from=%2Forg-briefing%3Fp%3Da');
  });
  it('a way back that is not valid falls back to the page\'s own address — never to the invalid value', () => {
    expect(pairReturnQuery('/inbox', '//evil.example')).toBe('?from=%2Finbox');
    expect(pairReturnQuery('/onboarding', 'https://evil.example/today')).toBe('');
    expect(pairReturnQuery('/onboarding', '/desktop/pair')).toBe('');
    expect(pairReturnQuery('/onboarding', null)).toBe(''); // the sign-up screen alone adds nothing
  });
  it('a page that is not a return target (or no page yet) adds nothing — the address as before', () => {
    expect(pairReturnQuery('')).toBe('');
    expect(pairReturnQuery(null)).toBe('');
    expect(pairReturnQuery('/board')).toBe('');
    expect(pairReturnQuery('https://evil.example/today')).toBe('');
    expect(pairReturnQuery('/desktop/pair?from=%2Ftoday')).toBe(''); // never chains itself
  });
});
