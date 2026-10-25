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
  it('a page that is not a return target (or no page yet) adds nothing — the address as before', () => {
    expect(pairReturnQuery('')).toBe('');
    expect(pairReturnQuery(null)).toBe('');
    expect(pairReturnQuery('/board')).toBe('');
    expect(pairReturnQuery('https://evil.example/today')).toBe('');
    expect(pairReturnQuery('/desktop/pair?from=%2Ftoday')).toBe(''); // never chains itself
  });
});
