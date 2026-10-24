// @vitest-environment jsdom
//
// story 4715 (UX-1 · plan yuna/4715-plan-1016.md §4) — the web first screens: no organization-name step (the organization is made with a
// made name), no fork (one screen: on a Mac [Mac 앱 받기] · elsewhere «지금은 Mac 앱만 있어요»), pending invites first (no organization
// made while invites exist or cannot be read), the web way behind a link with project → agent → connect at 1/3 · 2/3 · 3/3.
// Each test names the line that, reverted, turns it red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm, onboardingProgress } from './onboarding-form';
import koMessages from '../../../messages/ko.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';

// the phone app has a store link to show (as the card's own test) — so «is the card on this screen» can be told apart from «nothing to get»
vi.mock('@/lib/phone-app-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/phone-app-store')>()),
  PHONE_APP_PUBLISHED: { android: true, ios: false },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
// a manifest the card accepts (desktop-downloads.ts: https · storage.googleapis.com · inside our bucket) — so the download button is drawn
const MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.4.0', build: 'abc1234', notarized: true,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/Sprintable-Dev-Setup.dmg',
};
const INVITE = { invite_id: 'inv-1', org_id: 'org-x', org_name: '문클랩스', role: 'member', expires_at: '2026-10-30T00:00:00Z' };

type Me = { member_id: string; email_verified: boolean; org_id?: string | null; org_member_id?: string | null; display_name?: string | null };
interface Opts { me?: Me; invites?: unknown[] | 'fail'; meFails?: boolean }
interface Call { url: string; body?: Record<string, unknown> }

let calls: Call[];
let container: HTMLDivElement;
let root: Root;
let opts: Opts;
const realUserAgent = navigator.userAgent;

function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

function stubFetch(o: Opts = {}) {
  calls = [];
  opts = o;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    const ok = (json: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => json });
    if (url.endsWith('/api/onboarding/events')) return ok({});
    if (url.endsWith('/api/auth/me') && opts.meFails) return { ok: false, status: 503, headers: new Headers(), json: async () => ({}) };
    if (url.endsWith('/api/auth/me')) return ok({ data: opts.me ?? { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: '김지우' } });
    if (url.endsWith('/api/invites/mine')) {
      if (opts.invites === 'fail') return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) };
      return ok({ invites: opts.invites ?? [] }); // the backend's one shape (MyInvitesResponse · no envelope)
    }
    if (url.endsWith('/api/organizations')) return ok({ data: { id: 'org-1' } });
    if (url.endsWith('/api/auth/refresh')) return ok({ data: { ok: true } }); // the route's real success answer (story 4763: an answer without `data` is not a renewal)
    if (url.endsWith('/api/projects')) return ok({ data: { id: 'proj-1' } });
    if (url.endsWith('/api/current-project')) return ok({});
    if (url.endsWith('/desktop/downloads/macos.json')) return { ok: true, json: async () => MANIFEST, headers: new Headers({ 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' }) };
    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
  }));
}

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

async function flush() {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

async function mount() {
  await act(async () => { root.render(wrap(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
  await flush();
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

const first = koMessages.onboarding.first;
const byTestId = (id: string) => container.querySelector(`[data-testid=${id}]`);
const h1 = () => container.querySelector('h1')?.textContent?.trim();
const orgPosts = () => calls.filter((c) => c.url.endsWith('/api/organizations'));
const eventsSent = (event: string) => calls.filter((c) => c.url.endsWith('/api/onboarding/events') && c.body?.event === event);

beforeEach(() => {
  setUserAgent(MAC_UA);
  stubFetch();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  setUserAgent(realUserAgent);
});

describe('[SID:4715] AC1 — no organization-name step: the organization is made with a made name', () => {
  it('T1 arrival → one POST /api/organizations with «{name}의 조직» · no text field · the one screen with the organization line', async () => {
    await mount();
    expect(orgPosts()).toHaveLength(1);
    // reverted (the name field back) → no POST on arrival and a text input on screen
    expect(orgPosts()[0]!.body).toEqual({ name: '김지우의 조직' });
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(h1()).toBe(first.macTitle);
    expect(byTestId('onboarding-first-org')?.textContent).toBe('김지우의 조직에서 시작해요 · 이름은 설정에서 바꿀 수 있어요');
  });

  it('T1b no display name → «내 조직» · already a member → nothing made and no organization line (the name is not known here)', async () => {
    stubFetch({ me: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: null } });
    await mount();
    expect(orgPosts()[0]!.body).toEqual({ name: koMessages.desktopOnboarding.defaultOrgName });
    await act(async () => { root.render(wrap(<div />)); });

    stubFetch({ me: { member_id: 'u-1', email_verified: true, org_id: 'org-1', org_member_id: 'om-1' } });
    await mount();
    expect(orgPosts()).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith('/api/invites/mine'))).toBe(false);
    expect(h1()).toBe(first.macTitle);
    expect(byTestId('onboarding-first-org')).toBeNull();
  });
});

describe('[SID:4715] AC6 — pending invites first: no organization is made while invites exist or cannot be read', () => {
  it('T2 a pending invite → the invited card, no POST · «초대와 따로 내 조직 만들기» → one POST and the one screen', async () => {
    stubFetch({ invites: [INVITE] });
    await mount();
    // reverted (the invites not read before making) → a POST here
    expect(orgPosts()).toHaveLength(0);
    expect(byTestId('setup-invited')?.textContent).toContain(koMessages.desktop.setup.invited.title);
    expect(byTestId('setup-invited')?.textContent).toContain('문클랩스');
    await click(byTestId('setup-invited-own-org'));
    expect(orgPosts()).toHaveLength(1);
    expect(h1()).toBe(first.macTitle);
  });

  it('T2b the invites cannot be read → no POST · «초대를 확인하지 못했어요 …» + [다시 확인] · a good answer then makes it', async () => {
    stubFetch({ invites: 'fail' });
    await mount();
    // reverted (a failed read treated as «no invites») → a POST here
    expect(orgPosts()).toHaveLength(0);
    expect(byTestId('onboarding-invite-check-failed')?.textContent).toBe(koMessages.onboarding.inviteCheckFailed);
    opts.invites = [];
    await click(byTestId('onboarding-invite-check-again'));
    expect(orgPosts()).toHaveLength(1);
    expect(h1()).toBe(first.macTitle);
  });
});

describe('[SID:4715] 카디르 QA — an unreadable /api/auth/me is not «no organization» (rule 4832 on that read too)', () => {
  const meFails: Array<[string, (url: string) => unknown]> = [
    ['5xx', () => ({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) })],
    ['a network error', () => { throw new Error('network'); }],
    ['a 200 without an account ({})', () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) })],
    ['a 200 with data: null', () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: null }) })],
    ['a 200 with an empty account ({data:{}})', () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: {} }) })],
  ];
  it.each(meFails)('T7 me answers %s → no POST, no invite read · «계정을 확인하지 못했어요 …» + [다시 확인] · a good answer then makes it', async (_label, bad) => {
    stubFetch();
    const good = (globalThis.fetch as unknown as (u: RequestInfo | URL, i?: RequestInit) => Promise<unknown>);
    let failMe = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (failMe && url.endsWith('/api/auth/me')) { calls.push({ url }); return bad(url); }
      return good(input, init);
    }));
    await mount();
    // reverted (a failed me folded into «no organization») → the invites read succeeds as «none» and a POST goes out here
    expect(orgPosts()).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith('/api/invites/mine'))).toBe(false);
    expect(byTestId('onboarding-account-check-failed')?.textContent).toBe(koMessages.onboarding.accountCheckFailed);
    failMe = false;
    await click(byTestId('onboarding-account-check-again'));
    expect(orgPosts()).toHaveLength(1);
    expect(h1()).toBe(first.macTitle);
  });
});

describe('[SID:4715] self-QA — the choice «초대와 따로 내 조직 만들기» fails in view, and keeps its choice on retry', () => {
  it('T8 invited → own organization → the account check fails: the failure and [다시 확인] are on screen (not behind the invited card) · retry makes it once, the invites are not asked again', async () => {
    stubFetch({ invites: [INVITE] });
    await mount();
    expect(byTestId('onboarding-invited')).not.toBeNull();
    opts.meFails = true;
    await click(byTestId('setup-invited-own-org'));
    // reverted (the step stays «invited») → the card is still all there is, no line and no button
    expect(byTestId('onboarding-account-check-failed')?.textContent).toBe(koMessages.onboarding.accountCheckFailed);
    expect(byTestId('onboarding-invited')).toBeNull();
    expect(orgPosts()).toHaveLength(0);
    const inviteReadsBefore = calls.filter((c) => c.url.endsWith('/api/invites/mine')).length;
    opts.meFails = false;
    await click(byTestId('onboarding-account-check-again'));
    expect(orgPosts()).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/api/invites/mine')).length).toBe(inviteReadsBefore);
    expect(h1()).toBe(first.macTitle);
  });
});

describe('[SID:4715] self-QA — the phone app card stays on the first screen (story 4671: a Mac draws it too)', () => {
  it('T9 a Mac and a device that is not a Mac both draw the phone app card; the Mac screen keeps the one primary', async () => {
    await mount();
    // reverted (the card dropped from the Mac branch) → null here
    expect(byTestId('onboarding-first-mac')).not.toBeNull();
    expect(byTestId('phone-app-card')).not.toBeNull();
    await act(async () => { root.render(wrap(<div />)); });

    setUserAgent(PHONE_UA);
    stubFetch();
    await mount();
    expect(byTestId('onboarding-first-not-mac')).not.toBeNull();
    expect(byTestId('phone-app-card')).not.toBeNull();
  });
});

describe('[SID:4715] AC2 · AC3 — one screen in place of the fork and the download screen', () => {
  it('T3 a Mac: title · lead · [Mac 앱 받기] is the one primary · the web way is a small link · no fork radios', async () => {
    await mount();
    expect(container.textContent).toContain(first.macLead);
    expect(byTestId('desktop-download-button')?.textContent).toBe(first.macCta);
    const primaries = [...container.querySelectorAll('a, button')].filter((el) => el.className.includes('bg-primary'));
    expect(primaries.map((el) => el.getAttribute('data-testid'))).toEqual(['desktop-download-button']);
    // story 4766 (AC1): the web way is a FOLDED «고급» (a closed disclosure), not a link into a three-screen wizard; an app that is already
    // installed is opened, not downloaded again
    const fold = byTestId('onboarding-first-advanced') as HTMLDetailsElement | null;
    expect(fold?.tagName).toBe('DETAILS');
    expect(fold?.open).toBe(false);
    expect(byTestId('onboarding-first-advanced-summary')?.textContent).toBe(first.advancedSummary);
    expect(byTestId('onboarding-first-open-app')?.getAttribute('href')).toMatch(/^ai\.sprintable(\.dev)?:\/desktop\/setup$/);
    expect(byTestId('onboarding-first-connect')).toBeNull(); // the link into the wizard is gone
    expect(container.querySelector('input[type="radio"]')).toBeNull(); // reverted (the fork back) → radios
    expect(byTestId('onboarding-first-finish')?.textContent).toBe(koMessages.onboarding.desktopFinishToToday);
  });

  it('T4 not a Mac: «지금은 Mac 앱만 있어요» first · the web way is the button · no download card', async () => {
    setUserAgent(PHONE_UA);
    await mount();
    expect(h1()).toBe(first.notMacTitle);
    expect(container.textContent).toContain(first.notMacLead);
    // story 4766: the web way is the only way here, so it is not folded — the one press stands on the screen
    expect(byTestId('onboarding-first-advanced')?.tagName).toBe('SECTION');
    expect(byTestId('advanced-make')).not.toBeNull();
    expect(byTestId('desktop-download-card')).toBeNull();
  });

  it('T5 the folded web way holds the ONE press and the prerequisites (story 4766) — opening it needs no other screen', async () => {
    await mount();
    expect(h1()).toBe(first.macTitle); // still the one screen (no «1 / 3» wizard)
    expect(byTestId('onboarding-step-of')).toBeNull();
    expect(byTestId('advanced-make')?.textContent).toContain(koMessages.onboarding.advanced.make);
    expect(byTestId('advanced-prereq')).not.toBeNull();
    expect(byTestId('advanced-install-claude')).not.toBeNull();
    expect(byTestId('advanced-install-codex')).not.toBeNull();
  });

  it('T6 the download press counts the app way once (the 3983 funnel signal the fork used to send)', async () => {
    await mount();
    expect(eventsSent('desktop_handoff_selected')).toHaveLength(0);
    await click(byTestId('desktop-download-button'));
    expect(eventsSent('desktop_handoff_selected')).toHaveLength(1);
    expect(eventsSent('desktop_handoff_selected')[0]!.body).toMatchObject({ agent_id: null, meta: { flow: 'onboarding' } });
  });
});

describe('onboardingProgress — only the web way\'s three steps', () => {
  it('arrive · invited · first: none; project 1/3 · agent 2/3 · connect 3/3', () => {
    expect(onboardingProgress('arrive')).toBeNull();
    expect(onboardingProgress('invited')).toBeNull();
    expect(onboardingProgress('first')).toBeNull();
    expect(onboardingProgress('project')).toEqual({ fraction: 1 / 3, label: { current: 1, total: 3 } });
    expect(onboardingProgress('agent')).toEqual({ fraction: 2 / 3, label: { current: 2, total: 3 } });
    expect(onboardingProgress('connect')).toEqual({ fraction: 1, label: { current: 3, total: 3 } });
  });
});

describe('[4714 AC2] the form hands the server\'s download judgement to the phone app\'s first screen', () => {
  async function mountPhone(macDownloadEnabled: boolean) {
    await act(async () => {
      root.render(wrap(
        <PhoneBridgeContext.Provider value={{ inPhoneApp: true, phoneCall: (async () => ({ id: 'k', ok: false, code: 'no_screen_lock' })) as never }}>
          <OnboardingForm todayHref="/today" chatsHref="/chats" macDownloadEnabled={macDownloadEnabled} />
        </PhoneBridgeContext.Provider>,
      ));
    });
    await flush();
  }
  it('macDownloadEnabled reaches the no-Mac screen\'s mail button; absent/false draws none', async () => {
    setUserAgent(PHONE_UA);
    await mountPhone(false);
    expect(byTestId('onboarding-phone-no-mac')).not.toBeNull();
    expect(byTestId('onboarding-phone-mail')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mountPhone(true);
    expect(byTestId('onboarding-phone-mail-button')).not.toBeNull();
  });
});
