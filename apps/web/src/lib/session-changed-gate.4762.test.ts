// @vitest-environment jsdom
//
// story 4762 — the page's global fetch gate (`installProjectHeaderInterceptor`, mounted at the app root by FetchGateInstaller) tells the phone shell ONCE when a
// same-origin `/api/` response carries `x-session-changed` (set by every route that sets or clears the session cookies — see the guard test
// `lib/auth/session-cookie-routes.guard.test.ts`). The shell then writes the cookies to disk now: a force-quit seconds after a token rotation must not wake the app
// with the old token (measured on an Android phone: a claim-less sign-up token on disk → `/api/v2/me` 404 `membership_elsewhere` → a Next 404). Raw fetch, fetchWithAuth
// and Request inputs all pass this one gate, so the invitation-acceptance road (`/api/switch-org` through fetchWithAuth, the invite pages' fetches) is covered
// without a line of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
let answer: () => Response | Promise<Response>;

beforeEach(() => {
  vi.resetModules();
  post.mockReset();
  (window as unknown as { ReactNativeWebView?: { postMessage: (m: string) => void } }).ReactNativeWebView = { postMessage: post };
  (window as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.resolve(answer()));
});

afterEach(() => {
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  vi.restoreAllMocks();
});

async function install() {
  const ctx = await import('@/lib/project-context-client');
  ctx.installProjectHeaderInterceptor();
}

const marked = (init: ResponseInit = { status: 200 }) => new Response('{}', { ...init, headers: { 'x-session-changed': '1', ...(init.headers as Record<string, string> | undefined) } });
const types = () => post.mock.calls.map((c) => (JSON.parse(c[0] as string) as { type: string }).type);

describe('the fetch gate tells the shell when a response says the session changed', () => {
  it('a marked same-origin /api/ answer → exactly one `session-changed` (a POST like the invitation-acceptance switch-org)', async () => {
    answer = () => marked();
    await install();
    await window.fetch('/api/switch-org', { method: 'POST', body: '{}' });
    expect(types()).toEqual(['session-changed']);
  });

  it('whatever the method — a GET answer marked the same way counts too', async () => {
    answer = () => marked();
    await install();
    await window.fetch('/api/auth/refresh');
    expect(types()).toEqual(['session-changed']);
  });

  it('an absolute URL of the same origin and a Request input are the same road', async () => {
    answer = () => marked();
    await install();
    await window.fetch(`${window.location.origin}/api/auth/login`, { method: 'POST' });
    await window.fetch(new Request(`${window.location.origin}/api/switch-project`, { method: 'POST' }));
    expect(types()).toEqual(['session-changed', 'session-changed']);
  });

  it('an unmarked answer tells the shell nothing; neither does a header with another value', async () => {
    answer = () => new Response('{}', { status: 200 });
    await install();
    await window.fetch('/api/switch-org', { method: 'POST' });
    answer = () => new Response('{}', { status: 200, headers: { 'x-session-changed': '0' } });
    await window.fetch('/api/switch-org', { method: 'POST' });
    expect(post).not.toHaveBeenCalled();
  });

  it('another origin\'s answer is not trusted: the header there tells the shell nothing', async () => {
    answer = () => marked();
    await install();
    await window.fetch('https://other.example/api/auth/login', { method: 'POST' });
    expect(post).not.toHaveBeenCalled();
  });

  it('a protocol-relative URL (`//host/api/…`) is another origin, not a relative path — nothing is believed from it', async () => {
    answer = () => marked();
    await install();
    await window.fetch('//other.example/api/auth/login', { method: 'POST' });
    expect(post).not.toHaveBeenCalled();
  });

  it('an upper-case scheme, `data:` and `blob:` URLs are not this origin either (the origin is parsed, not pattern-matched)', async () => {
    answer = () => marked();
    await install();
    await window.fetch('HTTPS://OTHER.EXAMPLE/api/auth/login', { method: 'POST' });
    await window.fetch('data:text/plain,hello');
    await window.fetch('blob:https://other.example/0b1c');
    expect(post).not.toHaveBeenCalled();
    // control: the same page's own origin in upper-case scheme + host is believed
    await window.fetch(window.location.origin.toUpperCase() + '/api/auth/login', { method: 'POST' });
    expect(types()).toEqual(['session-changed']);
  });

  it('the mark is believed on ANY same-origin path: a protected page fetch whose session the proxy refreshed announces it too (only the origin decides, not `/api/`)', async () => {
    answer = () => marked();
    await install();
    await window.fetch('/glance', { method: 'GET' });
    expect(types()).toEqual(['session-changed']);
  });

  it('a URL-shaped input from another realm (no `instanceof URL`) is read by its href; an input with no readable url tells nobody', async () => {
    answer = () => marked();
    await install();
    await window.fetch({ href: 'https://other.example/api/auth/login' } as unknown as URL, { method: 'POST' });
    await window.fetch({} as unknown as URL, { method: 'POST' });
    expect(post).not.toHaveBeenCalled();
    await window.fetch({ href: `${window.location.origin}/api/auth/login` } as unknown as URL, { method: 'POST' });
    expect(types()).toEqual(['session-changed']);
  });

  it('a same-origin request that ended on another origin (a redirect) is not believed: the FINAL response url is checked too', async () => {
    answer = () => {
      const res = marked();
      Object.defineProperty(res, 'url', { value: 'https://other.example/api/auth/login' });
      return res;
    };
    await install();
    await window.fetch('/api/auth/login', { method: 'POST' });
    expect(post).not.toHaveBeenCalled();
    // control: the same answer ending on this origin is believed
    answer = () => {
      const res = marked();
      Object.defineProperty(res, 'url', { value: `${window.location.origin}/api/auth/login` });
      return res;
    };
    await window.fetch('/api/auth/login', { method: 'POST' });
    expect(types()).toEqual(['session-changed']);
  });

  it('the page\'s own sign-in and refresh helpers (lib/db/client) go through this gate: ONE message each (they used to post a second one themselves)', async () => {
    answer = () => new Response(JSON.stringify({ data: { access_token: 'at', refresh_token: 'rt', token_type: 'bearer' } }), { status: 200, headers: { 'x-session-changed': '1', 'content-type': 'application/json' } });
    await install();
    const { loginWithPassword, refreshAuthTokens } = await import('@/lib/db/client');
    await loginWithPassword('a@b.com', 'pw');
    expect(types()).toEqual(['session-changed']);
    await refreshAuthTokens();
    expect(types()).toEqual(['session-changed', 'session-changed']);
  });

  it('the response is handed on untouched (the body is still readable) and a failed request still fails the same way, with no message', async () => {
    answer = () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'x-session-changed': '1' } });
    await install();
    const res = await window.fetch('/api/switch-org', { method: 'POST' });
    expect(await res.json()).toEqual({ data: { ok: true } });
    post.mockReset();
    // a rejected request: the rejection comes through unchanged and nothing is sent to the shell
    vi.resetModules();
    (window as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('network')));
    await install();
    await expect(window.fetch('/api/switch-org', { method: 'POST' })).rejects.toThrow('network');
    expect(post).not.toHaveBeenCalled();
  });

  it('outside the native shell it is quiet (no ReactNativeWebView) and the answer still comes back', async () => {
    delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
    answer = () => marked();
    await install();
    const res = await window.fetch('/api/switch-org', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
