// @vitest-environment jsdom
//
// story 4668 (PO 2026-10-15, dev walk with a new free-plan account): sign-up → verify → «조직 만들기» → «어디서 돌릴까요» → app →
// «데스크톱 앱 받기». A reload there (or a re-opened `/onboarding?signup=1`) drew «조직 만들기» again, and the name typed into it ended in
// «업그레이드가 필요해요 · 무료 플랜은 조직을 1개까지». The screens now ask `/api/auth/me` and, when the account already has an
// organization, skip the organization step: the usual onboarding goes on to the fork, the desktop's one screen goes on to the setup page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import { DesktopCreateOrg } from './desktop-create-org';
import { existingOrgIdFromMe } from './existing-org';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Me = { member_id: string; org_id: string | null; org_member_id?: string | null; email_verified?: boolean; display_name?: string | null };
const WITH_ORG: Me = { member_id: 'u1', org_id: 'org-1', org_member_id: 'om-1', email_verified: true };
// the claim an organization deleted from the settings page leaves behind: org_id in the JWT, no membership row any more
const STALE_CLAIM: Me = { member_id: 'u1', org_id: 'org-gone', org_member_id: null, email_verified: true };
const NO_ORG: Me = { member_id: 'u1', org_id: null, org_member_id: null, email_verified: true };

let container: HTMLDivElement;
let root: Root;
let urls: string[];
let hrefSet: string[];

function stubFetch(me: Me) {
  urls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data, error: null, meta: null }) } as Response);
    if (url === '/api/auth/me') return ok(me);
    if (url === '/api/onboarding/events') return ok({});
    if (url === '/api/organizations/org-1/remote-control') return ok({ enabled: false, enabled_at: null, can_change: true, owner_names: [] });
    throw new Error('unexpected fetch: ' + url);
  }));
}

function provider(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const text = () => container.textContent ?? '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  hrefSet = [];
  sessionStorage.clear();
  vi.stubGlobal('location', { ...window.location, set href(v: string) { hrefSet.push(v); }, get href() { return 'http://localhost/onboarding'; } });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('[SID:4668] existingOrgIdFromMe — a live membership, not just the JWT\'s claim', () => {
  it('org_id + org_member_id → the id · org_id alone (a deleted organization\'s stale claim) · no org · no answer → null', () => {
    expect(existingOrgIdFromMe({ data: WITH_ORG })).toBe('org-1');
    expect(existingOrgIdFromMe({ data: STALE_CLAIM })).toBeNull();
    expect(existingOrgIdFromMe({ data: NO_ORG })).toBeNull();
    expect(existingOrgIdFromMe({ data: { org_id: null, org_member_id: 'om-1' } })).toBeNull();
    expect(existingOrgIdFromMe(null)).toBeNull();
    expect(existingOrgIdFromMe(undefined)).toBeNull();
    expect(existingOrgIdFromMe({})).toBeNull();
  });
});

describe('[SID:4668] the usual onboarding (OnboardingForm)', () => {
  it('an account with an organization lands on the fork, not on «조직 만들기» — no organization is ever asked for', async () => {
    stubFetch(WITH_ORG);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(text()).toContain('에이전트를 어디서 돌릴까요?');
    expect(container.querySelector('[data-testid="onboarding-where-continue"]')).not.toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull(); // no organization name field
    expect(text()).not.toContain('조직 이름');
    expect(urls).not.toContain('/api/organizations'); // reverted (the form ignores the membership) → fails
  });

  it('the fork carries that organization on: [계속] with the app way opens the download step', async () => {
    stubFetch(WITH_ORG);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    await act(async () => { (container.querySelector('[data-testid="onboarding-where-continue"]') as HTMLButtonElement).click(); });
    await settle();
    expect(text()).toContain('데스크톱 앱 받기');
    // «더 보기» holds the organization's remote-control line: it reads THIS organization's switch (the id came from the membership,
    // not from a form the person filled)
    await act(async () => { (container.querySelector('[data-testid="onboarding-download-more"]') as HTMLButtonElement).click(); });
    await settle();
    expect(urls).toContain('/api/organizations/org-1/remote-control');
  });

  it('a stale claim (the organization was deleted from the settings page) or no organization → «조직 만들기» as before', async () => {
    for (const me of [STALE_CLAIM, NO_ORG]) {
      stubFetch(me);
      await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
      await settle();
      expect(text()).toContain('조직 만들기');
      expect(text()).not.toContain('에이전트를 어디서 돌릴까요?');
      expect(container.querySelector('input[type="text"]')).not.toBeNull();
      await act(async () => { root.render(provider(<div />)); });
    }
  });

  it('a link that already names the step (`?step=project`) is not touched — the check only runs on the organization step', async () => {
    stubFetch(WITH_ORG);
    await act(async () => { root.render(provider(<OnboardingForm initialStep="project" initialOrgId="org-1" todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(urls).not.toContain('/api/auth/me');
    expect(text()).not.toContain('에이전트를 어디서 돌릴까요?');
  });
});

describe('[SID:4668] the desktop sign-up\'s one screen (DesktopCreateOrg)', () => {
  it('an account with an organization goes on to the setup page — the screen makes no second organization', async () => {
    stubFetch(WITH_ORG);
    await act(async () => { root.render(provider(<DesktopCreateOrg next="/desktop/setup" />)); });
    await settle();
    expect(hrefSet).toEqual(['/desktop/setup']); // reverted → fails
    expect(urls).not.toContain('/api/organizations');
    expect(urls).not.toContain('/api/projects');
  });

  it('no organization · a stale claim → the screen stays (nothing sent anywhere)', async () => {
    for (const me of [NO_ORG, STALE_CLAIM]) {
      hrefSet = [];
      stubFetch(me);
      await act(async () => { root.render(provider(<DesktopCreateOrg next="/desktop/setup" />)); });
      await settle();
      expect(hrefSet).toEqual([]);
      expect(text()).toContain('조직 만들기');
      await act(async () => { root.render(provider(<div />)); });
    }
  });
});
