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
import { DELETED_CHECK_MAX_MS, OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Me = { member_id: string; org_id: string | null; org_member_id?: string | null; email_verified?: boolean; display_name?: string | null };
const WITH_ORG: Me = { member_id: 'u1', org_id: 'org-1', org_member_id: 'om-1', email_verified: true };
const NO_ORG: Me = { member_id: 'u1', org_id: null, org_member_id: null, email_verified: true };

let container: HTMLDivElement;
let root: Root;
let urls: string[];

/** `meAnswers`: what each `/api/auth/me` read answers, in order (the last one repeats); `'down'` = the read fails. */
type Renewal = 'ok' | '503' | '401' | '429' | 'network' | 'not-json' | 'empty' | 'no-refresh-token';
function stubFetch(meAnswers: Array<Me | 'down' | 'expired'>, renewal: Renewal = 'ok', refreshGate?: Promise<void>) {
  urls = [];
  let meReads = 0;
  let somethingCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data, error: null, meta: null }) } as Response);
    if (url === '/api/auth/me') {
      const a = meAnswers[Math.min(meReads, meAnswers.length - 1)]!;
      meReads += 1;
      if (a === 'down') return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) } as Response;
      if (a === 'expired') return { ok: false, status: 401, headers: new Headers(), json: async () => ({}) } as Response; // an access token that ran out: fetchWithAuth renews and asks again
      return ok(a);
    }
    if (url === '/api/something') return { ok: somethingCalls++ > 0, status: somethingCalls > 1 ? 200 : 401, headers: new Headers(), json: async () => ({}) } as Response;
    if (url === '/api/onboarding/events') return ok({});
    if (url === '/api/organizations/org-1/remote-control') return ok({ enabled: false, enabled_at: null, can_change: true, owner_names: [] });
    if (url === '/api/invites/mine') return { ok: true, status: 200, headers: new Headers(), json: async () => ({ invites: [] }) } as Response;
    if (url === '/api/organizations') return ok({ id: 'org-new' });
    if (url === '/api/auth/refresh') {
      if (refreshGate) await refreshGate;
      if (renewal === 'network') throw new Error('network');
      if (renewal === 'empty') return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) } as Response; // a 2xx that carries nothing is not a renewal
      if (renewal === 'no-refresh-token') return { ok: false, status: 401, headers: new Headers(), json: async () => ({ error: { code: 'NO_REFRESH_TOKEN', message: 'No refresh token' } }) } as Response;
      if (renewal === 'not-json') return { ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('not json'); } } as unknown as Response;
      if (renewal !== 'ok') return { ok: false, status: Number(renewal), headers: new Headers(), json: async () => ({ data: null, error: { code: 'X', message: 'x' } }) } as Response;
      return ok({});
    }
    if (url === '/api/projects') return ok([]);
    if (url === '/api/current-project') return ok({});
    if (url.startsWith('/desktop/')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
    throw new Error('unexpected fetch: ' + url);
  }));
}

const provider = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const settle = () => act(async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); }); // the chain is long: shared renewal → account read → the check's end
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

  it.each<Renewal>(['503', '401', '429', 'network', 'not-json', 'empty'])('the renewal FAILS (%s) and the old token still says «no organization» → nothing is made, the account-check line with its retry (Kadir lens)', async (renewal) => {
    stubFetch([NO_ORG, NO_ORG], renewal);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(0);
    expect(byId('onboarding-account-check-failed')).not.toBeNull();
    expect(urls).not.toContain('/api/invites/mine');
  });

  it('a session with NO refresh token (the phone\'s Firebase session) has nothing to renew — that is not a failure: the organization is made once (codex)', async () => {
    stubFetch([NO_ORG, NO_ORG], 'no-refresh-token');
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(made()).toBe(1);
    expect(byId('onboarding-account-check-failed')).toBeNull();
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
    expect(urls).not.toContain('/api/invites/mine'); // it reads who the person is (below), nothing else, until the press
    await act(async () => { (byId('onboarding-org-deleted-new') as HTMLButtonElement).click(); });
    await settle();
    expect(made()).toBe(1);
    expect(byId('onboarding-org-deleted')).toBeNull();
  });

  it('another request of the page meets a 401 while the screen\'s own renewal is in flight: it joins that ONE rotation (the refresh token is single-use) (codex)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubFetch([NO_ORG, NO_ORG], 'ok', gate);
    const { fetchWithAuth } = await import('@/lib/db/client');
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle(); // the screen asked for its renewal; it has not come back
    expect(urls.filter((u) => u === '/api/auth/refresh')).toHaveLength(1);
    const other = fetchWithAuth('/api/something'); // its first answer is a 401 → it renews through the same flight
    await settle();
    expect(urls).toContain('/api/something');
    expect(urls.filter((u) => u === '/api/auth/refresh')).toHaveLength(1); // not a second rotation racing the first
    await act(async () => { release(); });
    await other;
    await settle();
    expect(byId('onboarding-org-deleted')).not.toBeNull(); // and the screen went on: no organization
  });

  it('the deleted card is not drawn until the quiet check has answered (no flash of «no organization» for someone who has one) (codex)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubFetch([WITH_ORG], 'ok', gate);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(byId('onboarding-org-deleted')).toBeNull();
    expect(byId('onboarding-org-deleted-checking')).not.toBeNull();
    await act(async () => { release(); });
    await settle();
    expect(byId('onboarding-org-deleted')).toBeNull(); // someone who has an organization never sees it
    expect(byId('onboarding-org-deleted-checking')).toBeNull();
  });

  it('the give-up limit is eight seconds, written out here (the test below reads the constant, so it moves with the constant: a limit made a hundred times longer would still pass it — Kadir)', () => {
    expect(DELETED_CHECK_MAX_MS).toBe(8000);
  });

  it('a quiet check that never answers (a request that hangs) does not leave a spinner for good: after DELETED_CHECK_MAX_MS the card is drawn (codex)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    try {
      stubFetch([NO_ORG], 'ok', hang); // the renewal does not come back (until this test lets it go: the page's ONE refresh flight must not stay stuck for the tests after it)
      await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
      await settle();
      expect(byId('onboarding-org-deleted-checking')).not.toBeNull();
      expect(byId('onboarding-org-deleted')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(DELETED_CHECK_MAX_MS - 1); });
      expect(byId('onboarding-org-deleted-checking')).not.toBeNull(); // not before the limit
      await act(async () => { vi.advanceTimersByTime(2); });
      await settle();
      expect(byId('onboarding-org-deleted')).not.toBeNull();
      expect(byId('onboarding-org-deleted-checking')).toBeNull();
    } finally {
      release();
      await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });
      vi.useRealTimers();
    }
  });

  it('someone who has an organization also loses `?after=org-deleted` from the address (a reload is the usual onboarding, not the check again) (codex)', async () => {
    window.history.replaceState(null, '', '/onboarding?after=org-deleted');
    stubFetch([WITH_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(window.location.search).toBe('');
  });

  it('a reload or an old link AFTER the new organization exists does not say «no organization» — the person goes on as an account with one (codex)', async () => {
    stubFetch([WITH_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(byId('onboarding-org-deleted')).toBeNull();
    expect(made()).toBe(0);
  });

  it('one of several organizations was deleted: the token is renewed first, so the person (who still has another) is not told «no organization» (Kadir lens)', async () => {
    stubFetch([WITH_ORG]); // what the account says AFTER the renewal (before it, the token still named the deleted organization)
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(urls).toContain('/api/auth/refresh');
    expect(urls.indexOf('/api/auth/refresh')).toBeLessThan(urls.lastIndexOf('/api/auth/me'));
    expect(byId('onboarding-org-deleted')).toBeNull();
    expect(made()).toBe(0);
  });

  it('the deleted screen\'s renewal FAILS and the account would still name an organization (an old token): the screen stays — it does not read and go on on that answer (Kadir lens)', async () => {
    stubFetch([WITH_ORG], '503');
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(byId('onboarding-org-deleted')).not.toBeNull();
    expect(urls).not.toContain('/api/auth/me');
  });

  it('a stale claim (an organization id in the token, no membership any more) still shows the deleted screen · an unreadable answer keeps it too', async () => {
    stubFetch([{ member_id: 'u1', org_id: 'org-gone', org_member_id: null, email_verified: true }]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(byId('onboarding-org-deleted')).not.toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubFetch(['down']);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(byId('onboarding-org-deleted')).not.toBeNull();
  });

  it('the press takes `?after=org-deleted` out of the address (a reload after it is the usual onboarding)', async () => {
    window.history.replaceState(null, '', '/onboarding?after=org-deleted');
    stubFetch([NO_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" afterOrgDelete />)); });
    await settle();
    expect(window.location.search).toBe('?after=org-deleted');
    await act(async () => { (byId('onboarding-org-deleted-new') as HTMLButtonElement).click(); });
    await settle();
    expect(window.location.search).toBe('');
  });

  it('without the flag the arrival is as before (organization made at once, no deleted screen)', async () => {
    stubFetch([NO_ORG]);
    await act(async () => { root.render(provider(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
    await settle();
    expect(byId('onboarding-org-deleted')).toBeNull();
    expect(made()).toBe(1);
  });
});
