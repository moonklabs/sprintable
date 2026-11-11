// @vitest-environment jsdom
//
// story 4904 — the same new account in two windows (a sign-up on the web, then the Mac app's login while the web arrival is still making the organization): the second window's arrival
// reads «no organization» (its token and its one renewal came before the other window's organization was committed), then its «조직 만들기» is refused by the free plan's limit — because the
// limit is the person's OWN organization, made a moment ago. The window must go on with that organization, not end in «무료 플랜은 조직을 1개까지».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Me = { member_id: string; org_id: string | null; org_member_id?: string | null; email_verified?: boolean };
const WITH_ORG: Me = { member_id: 'u1', org_id: 'org-1', org_member_id: 'om-1', email_verified: true };
const NO_ORG: Me = { member_id: 'u1', org_id: null, org_member_id: null, email_verified: true };

let container: HTMLDivElement;
let root: Root;
let urls: string[];

/** `meAnswers`: what each `/api/auth/me` read answers, in order (the last repeats); `'down'` = the read fails. `renewal`: whether `/api/auth/refresh` succeeds. */
const INVITE = { invite_id: 'inv-1', org_id: 'org-x', org_name: '문클랩스', role: 'member', expires_at: '2026-10-30T00:00:00Z' };
function stubFetch(meAnswers: Array<Me | 'down'>, renewal: 'ok' | '503' = 'ok', invites: unknown[] = []) {
  urls = [];
  let meReads = 0;
  let refreshes = 0;
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
    if (url === '/api/invites/mine') return { ok: true, status: 200, headers: new Headers(), json: async () => ({ invites }) } as Response;
    if (url === '/api/organizations') {
      return { ok: false, status: 402, headers: new Headers(), json: async () => ({ data: null, error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'Free plan org limit (1) reached.', resource: 'org', limit: 1, tier: 'free', upgrade_required: true }, meta: null }) } as Response;
    }
    if (url === '/api/auth/refresh') {
      refreshes += 1;
      if (renewal !== 'ok') return { ok: false, status: Number(renewal), headers: new Headers(), json: async () => ({ data: null, error: { code: 'X', message: 'x' } }) } as Response;
      return ok({});
    }
    if (url === '/api/organizations/org-1/remote-control') return ok({ enabled: false, enabled_at: null, can_change: true, owner_names: [] });
    if (url === '/api/projects') return ok([]);
    if (url === '/api/current-project') return ok({});
    if (url.startsWith('/desktop/')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
    throw new Error('unexpected fetch: ' + url + ' (refreshes so far ' + refreshes + ')');
  }));
}

const provider = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const settle = () => act(async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); });
const made = () => urls.filter((u) => u === '/api/organizations').length;
const limitModalShown = () => document.body.textContent?.includes('무료 플랜') ?? false;

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

describe('[SID:4904] the plan limit that is the person\'s own, just-made organization', () => {
  it('⭐ no organization at the arrival (two reads), the «조직 만들기» is refused by the limit, the renewed read shows the organization → no limit modal, the person goes on (the organization is asked for once)', async () => {
    stubFetch([NO_ORG, NO_ORG, WITH_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(1); // asked once — never a second time
    expect(limitModalShown()).toBe(false);
    expect(container.querySelector('[data-testid="onboarding-arrive"]')).toBeNull(); // not stuck on the arrival: the first screen is drawn
    // the re-read came after the refusal: refresh → me (the third read)
    const afterPost = urls.slice(urls.indexOf('/api/organizations') + 1);
    expect(afterPost).toContain('/api/auth/refresh');
    expect(afterPost).toContain('/api/auth/me');
  });

  it('the limit is the answer when the person has no organization even after the re-read (a real second one) → the modal as before', async () => {
    stubFetch([NO_ORG, NO_ORG, NO_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(1);
    expect(limitModalShown()).toBe(true);
  });

  it('⭐ the person chose «초대와 따로 내 조직 만들기» ON PURPOSE (pending invites) → the limit stays the answer: no silent join, even if the re-read would show an organization', async () => {
    // reads: arrival (2: none) → invited card → the press: arrival again (2: none) → «조직 만들기» refused → a re-read here would answer WITH_ORG (the 5th) — it must not be asked
    stubFetch([NO_ORG, NO_ORG, NO_ORG, NO_ORG, WITH_ORG], 'ok', [INVITE]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(0); // the invited card first
    await act(async () => { (container.querySelector('[data-testid="setup-invited-own-org"]') as HTMLButtonElement).click(); });
    await settle();
    expect(made()).toBe(1);
    expect(limitModalShown()).toBe(true);
  });

  it('the re-read cannot be read (the account answers 500) → not «has one»: the modal as before', async () => {
    stubFetch([NO_ORG, NO_ORG, 'down']);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(limitModalShown()).toBe(true);
  });

  it('the renewal FAILS after the refusal (503) → not «has one»: the modal as before (an organization is never assumed)', async () => {
    // the arrival's own renewal must succeed to get as far as the POST, so the first refresh answers ok and the later ones 503 — the simplest honest stub: ok then 503
    urls = [];
    let refreshes = 0;
    stubFetch([NO_ORG, NO_ORG, WITH_ORG]);
    const inner = globalThis.fetch as unknown as (i: RequestInfo | URL) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/refresh') {
        refreshes += 1;
        if (refreshes >= 2) { urls.push(url); return { ok: false, status: 503, headers: new Headers(), json: async () => ({ data: null, error: { code: 'X', message: 'x' } }) } as Response; }
      }
      return inner(input);
    }));
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(limitModalShown()).toBe(true);
  });
});
