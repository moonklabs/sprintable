// @vitest-environment jsdom
//
// story 4762 (AC7) — right after the organization is made the form rotates the session token (the new one carries the organization claim). In the phone app
// the shell must hear «session-changed» then (refreshAuthTokens of lib/db/client.ts sends it), so it writes the cookie to disk at once: the app can be force-quit
// seconds later, and the disk must hold the token WITH the claim (dev 10-24: it held the sign-up token → every open was a Next 404 until the next sign-in).
// Reverted (a bare fetch again) → no message.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const post = vi.fn();
let refreshAnswer: () => Promise<unknown> | unknown = () => ({ ok: true, json: async () => ({}) });

beforeEach(() => {
  refreshAnswer = () => ({ ok: true, json: async () => ({}) });
  post.mockReset();
  (window as unknown as { ReactNativeWebView?: { postMessage: (m: string) => void } }).ReactNativeWebView = { postMessage: post };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
    if (url === '/api/auth/me') return { ok: true, json: async () => ({ data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: '문클랩스' } }) };
    if (url === '/api/invites/mine') return { ok: true, json: async () => ({ invites: [] }) };
    if (url === '/api/auth/refresh') return refreshAnswer();
    if (url === '/api/organizations') return { ok: true, json: async () => ({ data: { id: 'org-1', slug: 'workspace-3f9a1c2b' } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); });
}

describe('[SID:4762] OnboardingForm — the phone shell is told when the organization-making rotates the session', () => {
  it('the token is rotated after the organization exists, and THEN the shell hears `session-changed` (once)', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    const fetchMock = vi.mocked(fetch);
    const orgAt = fetchMock.mock.calls.findIndex((c) => c[0] === '/api/organizations');
    const refreshAt = fetchMock.mock.calls.findIndex((c) => c[0] === '/api/auth/refresh');
    expect(orgAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(orgAt); // the rotation follows the organization
    const messages = post.mock.calls.map((c) => JSON.parse(c[0] as string) as { type: string });
    expect(messages.filter((m) => m.type === 'session-changed')).toHaveLength(1); // reverted (a raw fetch) → 0
    // and the message came after the refresh request, not before (the shell flushes what the cookie jar holds NOW)
    expect(vi.mocked(fetch).mock.invocationCallOrder[refreshAt]!).toBeLessThan(post.mock.invocationCallOrder[0]!);
  });

  it('the shell hears nothing while the rotation is still in flight — only once the server has answered (it must not flush the old cookie)', async () => {
    let release!: () => void;
    refreshAnswer = () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({}) }); });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === '/api/auth/refresh')).toBe(true); // the rotation was sent …
    expect(post).not.toHaveBeenCalled(); // … and is not answered yet: nothing to the shell
    await act(async () => { release(); for (let i = 0; i < 16; i++) await Promise.resolve(); });
    expect(post.mock.calls.map((c) => (JSON.parse(c[0] as string) as { type: string }).type)).toEqual(['session-changed']); // answered → exactly one message
  });

  it('on the leaving path the rotation comes BEFORE the page change (a navigation first would drop the message together with the page)', () => {
    const form = readFileSync(resolve(__dirname, 'onboarding-form.tsx'), 'utf8');
    const at = form.indexOf('const finishToHome = async () => {');
    expect(at).toBeGreaterThan(-1);
    const body = form.slice(at, form.indexOf('\n  };', at));
    expect(body.indexOf('await refreshAuthTokens()')).toBeGreaterThan(-1);
    expect(body.indexOf('await refreshAuthTokens()')).toBeLessThan(body.indexOf('window.location.href'));
  });

  it('both rotations of the form (after the organization is made · before leaving) go through refreshAuthTokens — no bare `/api/auth/refresh` fetch is left in the form', () => {
    const form = readFileSync(resolve(__dirname, 'onboarding-form.tsx'), 'utf8');
    expect(form).not.toMatch(/fetch\(\s*'\/api\/auth\/refresh'/); // reverted (a bare fetch) → the shell is never told
    // each one swallows a failure like the bare fetch did (the leaving one has no screen to fall back on: a throw there would keep the person from going home)
    expect(form.match(/await refreshAuthTokens\(\)\.catch\(\(\) => null\)/g)?.length).toBe(2);
    expect(form.match(/refreshAuthTokens\(\)/g)?.length).toBe(2);
    expect(form).toMatch(/import \{ fetchWithAuth, refreshAuthTokens \} from '@\/lib\/db\/client';/);
  });

  // The old bare `fetch(...).catch(() => null)` swallowed every failure of the rotation and the form went on; refreshAuthTokens can reject (a network error, an answer
  // that is not JSON) — the form must still go on quietly to the next step, exactly as before (PO 10-24).
  it.each([
    ['a network failure', () => { throw new Error('network'); }],
    ['an answer that is not JSON', () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
    ['a refused rotation (401)', () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'no' } }) })],
  ] as Array<[string, () => unknown]>)('the rotation failing (%s) does not stop the form: it still goes on to the next step, with no error line and no `session-changed`', async (_label, answer) => {
    refreshAnswer = answer;
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === '/api/auth/refresh')).toBe(true); // the rotation was tried
    expect([koMessages.onboarding.first.macTitle, koMessages.onboarding.first.notMacTitle]).toContain(container.querySelector('h1')?.textContent); // and the form went on to the one screen
    expect(container.textContent).not.toContain(koMessages.onboarding.networkError); // not into the «network error» state
    expect(post.mock.calls.filter((c) => (JSON.parse(c[0] as string) as { type: string }).type === 'session-changed')).toHaveLength(0);
  });
});
