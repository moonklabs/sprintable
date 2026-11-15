// @vitest-environment jsdom
//
// story 4906 (the first-run lap · PO 11-12 · found by the ko lane when it cleaned up its account): a person who deleted their ONLY organization lands on `/onboarding?after=org-deleted` — «조직을 삭제했어요» with ONE press, «새 조직 만들기» —
// and `/settings` sends them back to that page, so «계정 삭제» was out of reach until they made an organization again. The screen now has two quiet ways out beside the press: «로그아웃» and «계정 삭제» (the same confirmation window
// as Settings › 계정 삭제). What the press «새 조직 만들기» does is pinned by `onboarding-form.stale-session.4763.test.tsx`, unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string }>;
let assign: ReturnType<typeof vi.fn>;

const NO_ORG = { member_id: 'u1', org_id: null, org_member_id: null, email_verified: true };
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body }) as Response;

function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url === '/api/auth/me') return json(200, { data: NO_ORG, error: null, meta: null });
    if (url === '/api/auth/refresh') return json(200, { data: {}, error: null, meta: null });
    if (url === '/api/auth/logout') return json(200, {});
    if (url === '/api/account/delete-preview') return json(200, { data: { closing: [], blocked: [] } });
    if (url === '/api/account/delete' && init?.method === 'POST') return json(200, { data: { deleted: true } });
    if (url === '/api/onboarding/events') return json(200, {});
    if (url === '/api/invites/mine') return json(200, { invites: [] });
    return json(404, {});
  }));
}

const provider = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const settle = () => act(async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); });
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function mountDeleted() {
  await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
  await settle();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
  assign = vi.fn();
  stubFetch();
  vi.stubGlobal('location', { ...window.location, assign, search: '', pathname: '/onboarding', href: 'http://localhost/onboarding' });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('[SID:4906] the screen of a person with no organization', () => {
  it('⭐besides «새 조직 만들기» it has «로그아웃» and «계정 삭제» (quiet ds buttons)', async () => {
    await mountDeleted();
    expect(byId('onboarding-org-deleted')).not.toBeNull();
    expect(byId('onboarding-org-deleted-new')?.textContent).toBe(koMessages.onboarding.orgDeletedNew);
    for (const [id, text] of [['onboarding-org-deleted-logout', koMessages.common.logout], ['onboarding-org-deleted-delete-account', koMessages.settings.deleteAccount]] as const) {
      expect(byId(id)?.textContent).toBe(text);
      expect(byId(id)?.hidden, `${id} is shown`).toBe(false);
      expect(byId(id)?.getAttribute('data-slot')).toBe('ds-button');
    }
  });

  it('⭐«로그아웃» signs the person out (POST /api/auth/logout) and goes to the login page', async () => {
    await mountDeleted();
    await act(async () => { byId('onboarding-org-deleted-logout')!.click(); });
    await settle();
    expect(calls.filter((c) => c.url === '/api/auth/logout' && c.method === 'POST')).toHaveLength(1);
    expect(assign).toHaveBeenCalledWith('/login');
    expect(calls.some((c) => c.url === '/api/organizations')).toBe(false); // it made nothing behind the person's back
  });

  it('⭐«계정 삭제» opens the same confirmation window as Settings (it reads the preview first) — nothing is deleted by the press itself', async () => {
    await mountDeleted();
    expect(document.body.textContent).not.toContain(koMessages.settings.deleteConfirmTitle);
    await act(async () => { byId('onboarding-org-deleted-delete-account')!.click(); });
    await settle();
    expect(document.body.textContent).toContain(koMessages.settings.deleteConfirmTitle);
    expect(calls.some((c) => c.url === '/api/account/delete-preview')).toBe(true);
    expect(calls.some((c) => c.url === '/api/account/delete')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('⭐after the confirmation the account is deleted (POST /api/account/delete) and the person goes to the login page', async () => {
    await mountDeleted();
    await act(async () => { byId('onboarding-org-deleted-delete-account')!.click(); });
    await settle();
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="delete-account-confirm"]')!.click(); });
    await settle();
    expect(calls.filter((c) => c.url === '/api/account/delete' && c.method === 'POST')).toHaveLength(1);
    expect(assign).toHaveBeenCalledWith('/login');
  });
});
