// story 4712 AC4 (c) — [열기] as a plain form POST. Same lens as /api/desktop/continue (Kadir v2): the closed table, only a POST makes a code, Origin required,
// who the code is for comes from the SESSION — plus: every outcome is a 303 (never a bare error page in the person\'s browser).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ session: vi.fn(), backendFetch: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: h.session, SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));
vi.mock('@/lib/backend-fetch', () => ({ backendFetch: h.backendFetch }));

import * as route from './route';
import { resetContinueLimitForTests } from '@/lib/auth/desktop-continue-limit';

const CH = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const GOOD = { code_challenge: CH, cc_method: 'S256', callback_mode: 'custom_scheme' };
const USER = '8a1f5e3c-2b7d-4c9e-a6f0-1d2e3f4a5b6c';
const ORIGIN = 'http://localhost:3000';
const HERE = `/native/continue?code_challenge=${CH}&cc_method=S256&callback_mode=custom_scheme`;

const post = (fields: Record<string, string | string[]>, headers: Record<string, string> = { Origin: ORIGIN }) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return new Request('http://localhost:3000/native/continue/open', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: body.toString() });
};
const issueOk = (code = 'one-time-code-abc') => new Response(JSON.stringify({ code }), { status: 200 });

beforeEach(() => {
  h.session.mockReset().mockResolvedValue({ user_id: USER, email: 'jay@example.com', access_token: 't', org_id: null, project_id: null });
  h.backendFetch.mockReset().mockImplementation(async () => issueOk());
  resetContinueLimitForTests();
  process.env['FIREBASE_BFF_INTERNAL_SECRET'] = 'test-secret';
});

describe('POST /native/continue/open', () => {
  it('a signed-in person\'s form post: the existing issue is called ONCE for the app\'s challenge → 303 to the return page with the code (no body, no cache)', async () => {
    const res = await route.POST(post(GOOD));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/native/oauth-return?code=one-time-code-abc');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(await res.text()).toBe('');
    expect(h.backendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.backendFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/v2\/internal\/auth\/oauth-handoff\/issue$/);
    expect(JSON.parse(init.body)).toEqual({ user_id: USER, code_challenge: CH, callback_mode: 'custom_scheme', return_uri: 'ai.sprintable:/oauth-return' });
  });

  it('return_app=dev rides on the return page\'s address; who the code is for and where it may go come from the SESSION and the fixed table, not the form', async () => {
    const res = await route.POST(post({ ...GOOD, return_app: 'dev', user_id: '00000000-0000-4000-8000-0000000000aa', return_uri: 'https://evil.example/x' }));
    expect(res.headers.get('Location')).toBe('/native/oauth-return?code=one-time-code-abc&app=dev');
    expect(JSON.parse(h.backendFetch.mock.calls[0]![1].body)).toEqual({ user_id: USER, code_challenge: CH, callback_mode: 'custom_scheme', return_uri: 'ai.sprintable:/oauth-return' });
  });

  it('Origin is required (none at all is refused), another site\'s is refused; the issue is never called', async () => {
    expect((await route.POST(post(GOOD, {}))).status).toBe(403);
    expect((await route.POST(post(GOOD, { Origin: 'https://evil.example' }))).status).toBe(403);
    expect(h.backendFetch).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });

  it('off the closed table (a short challenge · https mode · an app off the table · a field given twice) → 303 to the page («open this from the app»), the issue never called', async () => {
    for (const bad of [{ ...GOOD, code_challenge: CH.slice(0, 40) }, { ...GOOD, callback_mode: 'https' }, { ...GOOD, return_app: 'prod' }, { ...GOOD, code_challenge: [CH, CH] }, {}]) {
      const res = await route.POST(post(bad));
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('/native/continue');
    }
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it('a body that is not a form → 303 to the page; no session → 303 to the sign-in with next = this page and the whole start (no code made)', async () => {
    const notForm = new Request('http://localhost:3000/native/continue/open', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{"x":1}' });
    expect((await route.POST(notForm)).headers.get('Location')).toBe('/native/continue');
    h.session.mockResolvedValue(null);
    const res = await route.POST(post(GOOD));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`/login?next=${encodeURIComponent(HERE)}`);
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it('the issue failing or the person over the limit → 303 back to the page with failed=1 (the page says so, the button is there again) — never a bare error page', async () => {
    h.backendFetch.mockImplementation(async () => new Response('{}', { status: 500 }));
    expect((await route.POST(post(GOOD))).headers.get('Location')).toBe(`${HERE}&failed=1`);
    h.backendFetch.mockImplementation(async () => new Response('not json', { status: 200 }));
    expect((await route.POST(post(GOOD))).headers.get('Location')).toBe(`${HERE}&failed=1`);
    h.backendFetch.mockReset().mockImplementation(async () => issueOk());
    resetContinueLimitForTests();
    for (let i = 0; i < 10; i++) await route.POST(post(GOOD));
    const over = await route.POST(post(GOOD));
    expect(over.headers.get('Location')).toBe(`${HERE}&failed=1`);
    expect(h.backendFetch).toHaveBeenCalledTimes(10);
  });

  it('only a POST makes a code: the route exports no GET', () => {
    expect(Object.keys(route).sort()).toEqual(['POST']);
  });
});
