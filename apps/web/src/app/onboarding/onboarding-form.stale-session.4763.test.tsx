// @vitest-environment jsdom
//
// story 4763 (AC11 · H6). AC11: sign up on the web, then log into the Mac app before the organization exists — the app's session is a token from
// before the organization, `/api/auth/me` (it reads the token) says «no organization», and the second «조직 만들기» ended in «무료 플랜은 조직을 1개까지».
// The arrival now renews the token once and asks again before it decides there is none. H6: deleting the only organization sent the person to
// `/onboarding`, which made a same-named organization behind their back — now it says what happened and makes the new one on their press.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Me = { member_id: string; org_id: string | null; org_member_id?: string | null; email_verified?: boolean; display_name?: string | null };
const WITH_ORG: Me = { member_id: 'u1', org_id: 'org-1', org_member_id: 'om-1', email_verified: true };
const NO_ORG: Me = { member_id: 'u1', org_id: null, org_member_id: null, email_verified: true };

let container: HTMLDivElement;
let root: Root;
let urls: string[];

/** `meAnswers`: what each `/api/auth/me` read answers, in order (the last one repeats); `'down'` = the read fails. */
function stubFetch(meAnswers: Array<Me | 'down'>) {
  urls = [];
  let meReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data, error: null, meta: null }) } as Response);
    if (url === '/api/auth/me') {
      const a = meAnswers[Math.min(meReads, meAnswers.length - 1)]!;
      meReads += 1;
      if (a === 'down') return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) } as Response;
      return ok(a);
    }
    if (url === '/api/onboarding/events') return ok({});
    if (url === '/api/organizations/org-1/remote-control') return ok({ enabled: false, enabled_at: null, can_change: true, owner_names: [] });
    if (url === '/api/invites/mine') return { ok: true, status: 200, headers: new Headers(), json: async () => ({ invites: [] }) } as Response;
    if (url === '/api/organizations') return ok({ id: 'org-new' });
    if (url === '/api/auth/refresh') return ok({});
    if (url === '/api/projects') return ok([]);
    if (url === '/api/current-project') return ok({});
    if (url.startsWith('/desktop/')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
    throw new Error('unexpected fetch: ' + url);
  }));
}

const provider = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const settle = () => act(async () => { for (let i = 0; i < 14; i++) await Promise.resolve(); });
const made = () => urls.filter((u) => u === '/api/organizations').length;
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('[SID:4763 AC11] a session token from before the organization existed', () => {
  it('«no organization» in the token, an organization after one renewal → none is made (the person goes on with the one they have)', async () => {
    stubFetch([NO_ORG, WITH_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(0);
    expect(urls).toContain('/api/auth/refresh');
    // the renewal comes before the second read, and the invites are never read for an account that has an organization
    expect(urls.indexOf('/api/auth/refresh')).toBeLessThan(urls.lastIndexOf('/api/auth/me'));
    expect(urls).not.toContain('/api/invites/mine');
  });

  it('still no organization after the renewal → the organization is made as before (once)', async () => {
    stubFetch([NO_ORG, NO_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(1);
  });

  it('the second read cannot be read → nothing is made, the account-check line with its retry (a failed read is not «none»)', async () => {
    stubFetch([NO_ORG, 'down']);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(0);
    expect(byId('onboarding-account-check-failed')).not.toBeNull();
    expect(byId('onboarding-account-check-again')).not.toBeNull();
  });

  it('an account that already shows its organization in the first read is not renewed at all (no extra round trip)', async () => {
    stubFetch([WITH_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(urls).not.toContain('/api/auth/refresh');
    expect(made()).toBe(0);
  });
});

describe('[SID:4763 H6] after the organization was deleted', () => {
  it('the screen says so and makes nothing until the press — then the new organization is made', async () => {
    stubFetch([NO_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(byId('onboarding-org-deleted')?.textContent).toContain(koMessages.onboarding.orgDeletedTitle);
    expect(byId('onboarding-org-deleted')?.textContent).toContain(koMessages.onboarding.orgDeletedBody);
    expect(made()).toBe(0);
    expect(urls).not.toContain('/api/auth/me'); // not even a read: the person decides first
    await act(async () => { (byId('onboarding-org-deleted-new') as HTMLButtonElement).click(); });
    await settle();
    expect(made()).toBe(1);
    expect(byId('onboarding-org-deleted')).toBeNull();
  });

  it('without the flag the arrival is as before (organization made at once, no deleted screen)', async () => {
    stubFetch([NO_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(byId('onboarding-org-deleted')).toBeNull();
    expect(made()).toBe(1);
  });
});
