// @vitest-environment jsdom
//
// story 4762 (AC7) — right after the organization is made the form rotates the session token (the new one carries the organization claim). In the phone app
// the shell must hear «session-changed» then (refreshAuthTokens of lib/db/client.ts sends it), so it writes the cookie to disk at once: the app can be force-quit
// seconds later, and the disk must hold the token WITH the claim (dev 10-24: it held the sign-up token → every open was a Next 404 until the next sign-in).
// Reverted (a bare fetch again) → no message.
// The message is posted by the page's ONE fetch gate (lib/project-context-client.ts, mounted at the app root — FetchGateInstaller in app/layout.tsx, so the onboarding
// page has it): the refresh route marks its answer `x-session-changed: 1` and the gate tells the shell. This test installs the REAL gate over a scripted `fetch`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import { installProjectHeaderInterceptor } from '@/lib/project-context-client';
import { SESSION_CHANGED_HEADER } from '@/lib/auth/session-changed-header';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const post = vi.fn();
// what the refresh route answers: the session cookies were rotated, and the route says so (`markSessionChanged`)
const rotated = () => ({ ok: true, headers: new Headers({ [SESSION_CHANGED_HEADER]: '1' }), json: async () => ({ data: { ok: true } }) });
let refreshAnswer: () => Promise<unknown> | unknown = rotated;
const handler = vi.fn(async (_url: string): Promise<unknown> => ({ ok: false, status: 404, json: async () => ({}) }));

beforeAll(() => {
  // the real gate over a scripted network: every request of the page goes through it, as in the app
  (window as unknown as { fetch: unknown }).fetch = (input: RequestInfo | URL) => handler(String(input));
  installProjectHeaderInterceptor();
});

beforeEach(() => {
  refreshAnswer = rotated;
  post.mockReset();
  (window as unknown as { ReactNativeWebView?: { postMessage: (m: string) => void } }).ReactNativeWebView = { postMessage: post };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  handler.mockReset();
  handler.mockImplementation(async (url: string) => {
    if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
    if (url === '/api/auth/me') return { ok: true, json: async () => ({ data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: '문클랩스' } }) };
    if (url === '/api/invites/mine') return { ok: true, json: async () => ({ invites: [] }) };
    if (url === '/api/auth/refresh') return refreshAnswer();
    if (url === '/api/organizations') return { ok: true, json: async () => ({ data: { id: 'org-1', slug: 'workspace-3f9a1c2b' } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
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
    const fetchMock = handler;
    const orgAt = fetchMock.mock.calls.findIndex((c) => c[0] === '/api/organizations');
    // story 4763 (AC11): the arrival renews once BEFORE it decides «no organization» (a token from before the organization existed) — that is the first rotation; the one that
    // follows the organization is the LAST of them
    const refreshCalls = fetchMock.mock.calls.map((c, i) => (c[0] === '/api/auth/refresh' ? i : -1)).filter((i) => i >= 0);
    const refreshAt = refreshCalls[refreshCalls.length - 1]!;
    expect(orgAt).toBeGreaterThan(-1);
    expect(refreshCalls).toHaveLength(2);
    expect(refreshCalls[0]!).toBeLessThan(orgAt); // 4763: the renewal before the decision
    expect(refreshAt).toBeGreaterThan(orgAt); // the rotation follows the organization
    const messages = post.mock.calls.map((c) => JSON.parse(c[0] as string) as { type: string });
    expect(messages.filter((m) => m.type === 'session-changed')).toHaveLength(2); // one per rotation; reverted (a raw fetch) → 0
    // and the message of the last rotation came after its refresh request, not before (the shell flushes what the cookie jar holds NOW)
    expect(handler.mock.invocationCallOrder[refreshAt]!).toBeLessThan(post.mock.invocationCallOrder[post.mock.invocationCallOrder.length - 1]!);
  });

  it('the shell hears nothing while the rotation is still in flight — only once the server has answered (it must not flush the old cookie)', async () => {
    let release!: () => void;
    refreshAnswer = () => new Promise((resolve) => { release = () => resolve(rotated()); });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(handler.mock.calls.some((c) => c[0] === '/api/auth/refresh')).toBe(true); // the first rotation (4763: before the decision) was sent …
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

  it('every rotation of the form (before the arrival decides · after the organization is made · before leaving) goes through refreshAuthTokens — no bare `/api/auth/refresh` fetch is left in the form', () => {
    const form = readFileSync(resolve(__dirname, 'onboarding-form.tsx'), 'utf8');
    expect(form).not.toMatch(/fetch\(\s*'\/api\/auth\/refresh'/); // reverted (a bare fetch) → the shell is never told
    // each one swallows a failure like the bare fetch did (the leaving one has no screen to fall back on: a throw there would keep the person from going home)
    // story 4763: the other renewals — before the arrival decides there is no organization (AC11) and on the organization-deleted screen (H6) — go through ONE shared helper (`renewSession`, a single
    // call in flight, its result read); it is the third place that calls `refreshAuthTokens()`
    expect(form.match(/await refreshAuthTokens\(\)\.catch\(\(\) => null\)/g)?.length).toBe(2);
    expect(form.match(/refreshAuthTokens\(\)/g)?.length).toBe(3);
    expect(form.match(/renewSession\(\)/g)?.length).toBe(2);
    expect(form).toMatch(/import \{ fetchWithAuth, refreshAuthTokens \} from '@\/lib\/db\/client';/);
  });

  // The old bare `fetch(...).catch(() => null)` swallowed every failure of the rotation and the form went on; refreshAuthTokens can reject (a network error, an answer
  // that is not JSON) — the form must still go on quietly to the next step, exactly as before (PO 10-24).
  it.each([
    ['a network failure', () => { throw new Error('network'); }],
    ['an answer that is not JSON', () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
    ['a refused rotation (401)', () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'no' } }) })],
  ] as Array<[string, () => unknown]>)('the rotation failing (%s) does not stop the form: it still goes on to the next step, with no error line and no `session-changed`', async (_label, answer) => {
    // story 4763: the FIRST rotation (the arrival renewing the token before it decides «no organization») must answer — a failed one stops the arrival, by design. What this test pins is the
    // rotations that come AFTER the organization is made: those failing change nothing for the person
    let rotations = 0;
    refreshAnswer = () => (++rotations === 1 ? rotated() : answer());
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(handler.mock.calls.some((c) => c[0] === '/api/auth/refresh')).toBe(true); // the rotation was tried
    expect([koMessages.onboarding.first.macTitle, koMessages.onboarding.first.notMacTitle]).toContain(container.querySelector('h1')?.textContent); // and the form went on to the one screen
    expect(container.textContent).not.toContain(koMessages.onboarding.networkError); // not into the «network error» state
    // the one `session-changed` is the first (answered) rotation's; the failing one tells the shell nothing
    expect(post.mock.calls.filter((c) => (JSON.parse(c[0] as string) as { type: string }).type === 'session-changed')).toHaveLength(1);
  });
});
