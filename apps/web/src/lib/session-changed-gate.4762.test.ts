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
