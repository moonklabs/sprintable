// story 4762 (Kadir lens on PR 5218) — the multi-account roads change the session cookies through the account-vault helpers
// (`setActiveAccount` · `discardActiveSession` · `clearAllAccounts`), not through a literal `cookies.set(SP_AT_COOKIE`. Each BRANCH that changes the session says so
// (`x-session-changed: 1`) so the page's fetch gate tells the phone shell; a branch that changes no session cookie says nothing. One test per branch — the guard
// (`lib/auth/session-cookie-routes.guard.test.ts`) only sees files, this sees the branches.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = new Map<string, string>();
const audit = vi.hoisted(() => ({
  valid: [] as Array<{ accountId: string; refreshToken: string }>,
  staleNames: [] as string[],
  activeId: null as string | null,
  decoded: null as string | null,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: () => null }));
vi.mock('@/lib/backend-fetch', () => ({
  backendFetch: vi.fn(async () => new Response(JSON.stringify({ data: { access_token: 'new-at', refresh_token: 'new-rt', project_id: null } }), { status: 200 })),
}));
vi.mock('@/lib/auth/account-vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account-vault')>()),
  auditVault: vi.fn(async () => ({ valid: audit.valid, staleNames: audit.staleNames })),
  getVerifiedActiveAccountId: vi.fn(async () => audit.activeId),
  decodeAccountId: vi.fn(async () => audit.decoded),
}));

import { POST as signout } from './signout-account/route';
import { POST as switchAccount } from './switch-account/route';
import { POST as addAccount } from './add-account/route';
import { GET as accounts } from '../accounts/route';

const HEADER = 'x-session-changed';
const post = (body: unknown) => new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });

beforeEach(() => {
  jar.clear();
  audit.valid = [];
  audit.staleNames = [];
  audit.activeId = null;
  audit.decoded = null;
});

describe('signout-account — every branch that clears or swaps the session says so', () => {
  it('scope all → marked', async () => {
    jar.set('sp_rt', 'rt');
    const res = await signout(post({ scope: 'all' }));
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADER)).toBe('1');
  });

  it('scope this with no account left → marked (the «clear everything» branch)', async () => {
    jar.set('sp_rt', 'rt');
    const res = await signout(post({ scope: 'this' }));
    expect(await res.json()).toEqual({ data: { ok: true, next: null } });
    expect(res.headers.get(HEADER)).toBe('1');
  });

  it('scope this with a next account → marked (the promotion branch)', async () => {
    jar.set('sp_rt', 'rt');
    audit.valid = [{ accountId: 'acct-2', refreshToken: 'rt-2' }];
    const res = await signout(post({ scope: 'this' }));
    expect((await res.json()).data.next).toBe('acct-2');
    expect(res.headers.get(HEADER)).toBe('1');
  });
});

describe('switch-account', () => {
  it('a corrupt active session is discarded → marked', async () => {
    jar.set('sp_at', 'at');
    jar.set('sp_rt', 'rt'); // both present, no verified active account = corrupt
    const res = await switchAccount(post({ account_id: 'acct-2' }));
    expect(res.status).toBe(401);
    expect(res.headers.get(HEADER)).toBe('1');
  });

  it('the swap makes the target the active session → marked', async () => {
    jar.set('sp_at', 'at');
    jar.set('sp_rt', 'rt');
    jar.set('sp_acct_rt_acct-2', 'rt-2');
    audit.activeId = 'acct-1';
    audit.decoded = 'acct-2';
    const res = await switchAccount(post({ account_id: 'acct-2' }));
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADER)).toBe('1');
  });

  it('a vault entry whose binding is wrong only drops that vault cookie — no session cookie changes → not marked', async () => {
    jar.set('sp_at', 'at');
    jar.set('sp_rt', 'rt');
    jar.set('sp_acct_rt_acct-2', 'rt-2');
    audit.activeId = 'acct-1';
    audit.decoded = 'someone-else';
    const res = await switchAccount(post({ account_id: 'acct-2' }));
    expect(res.status).toBe(400);
    expect(res.headers.get(HEADER)).toBeNull();
  });
});

describe('add-account / accounts — the corrupt-session discard', () => {
  it('add-account: a corrupt active session is discarded → marked', async () => {
    jar.set('sp_at', 'at');
    jar.set('sp_rt', 'rt');
    const res = await addAccount(post({}));
    expect(res.status).toBe(401);
    expect(res.headers.get(HEADER)).toBe('1');
  });

  it('accounts: a corrupt active session is discarded → marked', async () => {
    jar.set('sp_at', 'at');
    jar.set('sp_rt', 'rt');
    const res = await accounts(new Request('http://localhost/api/accounts'));
    expect(res.status).toBe(401);
    expect(res.headers.get(HEADER)).toBe('1');
  });
});
