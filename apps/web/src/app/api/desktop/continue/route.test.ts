// story 4712 — [열기]: the only place the one-time hand-off code is made for «브라우저 이어받기». Kadir v2 lens, three web-side conditions:
// ① where the code may go is a closed table (off the table → refused, issue never called) · ② only the POST makes a code (no GET handler;
// Origin required — none at all is refused, another site's is refused) · and the code is for the PKCE challenge the app sent.
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

const post = (body: unknown, headers: Record<string, string> = { Origin: ORIGIN }) =>
  new Request('http://localhost:3000/api/desktop/continue', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const issueOk = (code = 'one-time-code-abc') => new Response(JSON.stringify({ code }), { status: 200 });

beforeEach(() => {
  h.session.mockReset().mockResolvedValue({ user_id: USER, email: 'jay@example.com', access_token: 't', org_id: null, project_id: null });
  // a fresh Response each call (a Response body can be read once)
  h.backendFetch.mockReset().mockImplementation(async () => issueOk());
  resetContinueLimitForTests();
  process.env['FIREBASE_BFF_INTERNAL_SECRET'] = 'test-secret';
});

describe('POST /api/desktop/continue', () => {
  it('a signed-in person pressing [열기]: the existing issue is called ONCE for the app\'s challenge, custom_scheme, the fixed return uri — and the answer is the return page with the code', async () => {
    const res = await route.POST(post(GOOD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: '/native/oauth-return?code=one-time-code-abc' } });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(h.backendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.backendFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/v2\/internal\/auth\/oauth-handoff\/issue$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(init.body)).toEqual({ user_id: USER, code_challenge: CH, callback_mode: 'custom_scheme', return_uri: 'ai.sprintable:/oauth-return' });
  });

  it('return_app=dev rides on the answer\'s address (so the dev app opens) — and nothing else about it reaches the issue call', async () => {
    const res = await route.POST(post({ ...GOOD, return_app: 'dev' }));
    expect((await res.json()).data.url).toBe('/native/oauth-return?code=one-time-code-abc&app=dev');
    expect(JSON.parse(h.backendFetch.mock.calls[0]![1].body)).not.toHaveProperty('return_app');
  });

  it('who the code is for and where it may go come from the SESSION and the fixed table — a user_id or return_uri in the body is ignored', async () => {
    const res = await route.POST(post({ ...GOOD, user_id: '00000000-0000-4000-8000-0000000000aa', return_uri: 'https://evil.example/x', org_id: 'x' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(h.backendFetch.mock.calls[0]![1].body)).toEqual({
      user_id: USER, code_challenge: CH, callback_mode: 'custom_scheme', return_uri: 'ai.sprintable:/oauth-return',
    });
  });

  it('there is no GET (or any other method): a page load can never make a code — POST is the route file\'s only export', () => {
    expect(Object.keys(route)).toEqual(['POST']);
  });

  it.each([
    ['no Origin at all (the shared check would let this through)', {} as Record<string, string>],
    ['another site\'s Origin', { Origin: 'https://evil.example' }],
  ])('%s → 403 and the issue is never called', async (_n, headers) => {
    const res = await route.POST(post(GOOD, headers));
    expect(res.status).toBe(403);
    expect(h.backendFetch).not.toHaveBeenCalled();
    expect(h.session).not.toHaveBeenCalled();
  });

  it('nobody signed in → 401 and the issue is never called', async () => {
    h.session.mockResolvedValue(null);
    const res = await route.POST(post(GOOD));
    expect(res.status).toBe(401);
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a challenge one character short', { ...GOOD, code_challenge: CH.slice(0, 42) }],
    ['a challenge with a character outside base64url', { ...GOOD, code_challenge: `${CH.slice(0, 42)}+` }],
    ['no challenge', { cc_method: 'S256', callback_mode: 'custom_scheme' }],
    ['method plain', { ...GOOD, cc_method: 'plain' }],
    ['mode https (the code to a web address)', { ...GOOD, callback_mode: 'https' }],
    ['return_app off the table', { ...GOOD, return_app: 'prod' }],
    ['return_app empty', { ...GOOD, return_app: '' }],
    ['return_app a scheme', { ...GOOD, return_app: 'evil.scheme' }],
  ])('%s → 400 and the issue is never called (Kadir v2 ①)', async (_n, body) => {
    const res = await route.POST(post(body));
    expect(res.status).toBe(400);
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it('a body that is not an object (or not JSON) → 400, no issue', async () => {
    for (const body of ['not json', '[]', 'null', '"x"']) {
      expect((await route.POST(post(body))).status).toBe(400);
    }
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it('a value that is not a string cannot slip past the check (a number or an array in the challenge)', async () => {
    expect((await route.POST(post({ ...GOOD, code_challenge: 12345 }))).status).toBe(400);
    expect((await route.POST(post({ ...GOOD, code_challenge: [CH] }))).status).toBe(400);
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it('an optional return_app that is malformed (null · a number · a list) is refused, not read as «absent» and defaulted (codex round: LOW)', async () => {
    for (const bad of [null, 1, ['dev'], ['dev', 'dev'], {}]) {
      expect((await route.POST(post({ ...GOOD, return_app: bad }))).status).toBe(400);
    }
    expect(h.backendFetch).not.toHaveBeenCalled();
  });

  it('the server cannot issue (error · no code · network) → 502 and no code anywhere in the answer', async () => {
    h.backendFetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    expect((await route.POST(post(GOOD))).status).toBe(502);
    h.backendFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    expect((await route.POST(post(GOOD))).status).toBe(502);
    h.backendFetch.mockRejectedValueOnce(new Error('down'));
    const res = await route.POST(post(GOOD));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('one-time-code');
  });

  it('per person: the 11th press in the window is 429 and makes no code; another person is not counted', async () => {
    for (let i = 0; i < 10; i++) expect((await route.POST(post(GOOD))).status).toBe(200);
    h.backendFetch.mockClear(); // (mockClear keeps the implementation)
    expect((await route.POST(post(GOOD))).status).toBe(429);
    expect(h.backendFetch).not.toHaveBeenCalled();
    h.session.mockResolvedValue({ user_id: 'b1b2b3b4-0000-4000-8000-000000000001', email: 'x@example.com', access_token: 't', org_id: null, project_id: null });
    expect((await route.POST(post(GOOD))).status).toBe(200);
  });

  it('a refused start does not use up the person\'s count', async () => {
    for (let i = 0; i < 20; i++) await route.POST(post({ ...GOOD, return_app: 'prod' }));
    expect((await route.POST(post(GOOD))).status).toBe(200);
  });
});
