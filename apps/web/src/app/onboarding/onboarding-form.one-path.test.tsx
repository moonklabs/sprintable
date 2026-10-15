// @vitest-environment jsdom
//
// story 4668 (UX-1 · U1 · design mirko/4668-design.md §4 T1~T7) — the onboarding as one way: after the organization a fork
// («에이전트를 어디서 돌릴까요?»), the app way skips project · agent · connect for one screen «데스크톱 앱 받기», the web way keeps
// the three steps, and the agent step's [건너뛰기] goes to the connect step (not home). Each test names the line that, reverted,
// turns it red. New sibling file — the existing onboarding-form.*.test.tsx stay as they are.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm, onboardingProgress } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
// a manifest the card accepts (desktop-downloads.ts: https · storage.googleapis.com · inside our bucket) — so [다운로드] is drawn
const MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.4.0', build: 'abc1234', notarized: true,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/Sprintable-Dev-Setup.dmg',
};

interface Call { url: string; body?: Record<string, unknown> }
let calls: Call[];
let container: HTMLDivElement;
let root: Root;
const realUserAgent = navigator.userAgent;

function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (url.endsWith('/api/onboarding/events')) return { ok: true, json: async () => ({}) };
    if (url.endsWith('/api/auth/me')) return { ok: true, json: async () => ({ data: { member_id: 'u-1', email_verified: true } }) };
    if (url.endsWith('/api/organizations')) return { ok: true, json: async () => ({ data: { id: 'org-1' } }) };
    if (url.endsWith('/api/auth/refresh')) return { ok: true, json: async () => ({}) };
    if (url.endsWith('/api/projects')) return { ok: true, json: async () => ({ data: { id: 'proj-1' } }) };
    if (url.endsWith('/api/current-project')) return { ok: true, json: async () => ({}) };
    if (url.endsWith('/api/team-members')) return { ok: true, json: async () => ({ data: { id: 'agent-1', api_key: 'sk_live_abcd1234' } }) };
    if (url.endsWith('/desktop/downloads/macos.json')) return { ok: true, json: async () => MANIFEST, headers: new Headers({ 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' }) };
    // remote control · connection artifact · verification — none of them matters here; a 404 is handled by each component
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

const h1 = () => container.querySelector('h1')?.textContent?.trim();
const stepOf = () => container.querySelector('[data-testid=onboarding-step-of]')?.textContent?.trim() ?? null;
const barWidth = () => (container.querySelector('[data-testid=onboarding-progress-bar]') as HTMLElement).style.width;
const byTestId = (id: string) => container.querySelector(`[data-testid=${id}]`);
const eventsSent = (event: string) => calls.filter((c) => c.url.endsWith('/api/onboarding/events') && c.body?.event === event);

async function mountAndMakeOrg() {
  await act(async () => { root.render(wrap(<OnboardingForm todayHref="/today" chatsHref="/chats" />)); });
  await flush();
  const orgNameInput = container.querySelector('input') as HTMLInputElement;
  await act(async () => { setNativeValue(orgNameInput, 'My Org'); });
  await click(buttonByText(koMessages.onboarding.createOrg));
}

async function chooseWeb() {
  const webRadio = container.querySelector('[data-testid=onboarding-where-web] input') as HTMLInputElement;
  await act(async () => { webRadio.click(); });
  await flush();
}

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
  window.sessionStorage.clear();
});

describe('onboardingProgress — bar only before the fork, the fraction after it (PO · Yuna 07:16Z)', () => {
  it('org · where: no fraction, the width follows the choice (app 3 screens · web 5); after: 3/3 or 3/5 · 4/5 · 5/5', () => {
    expect(onboardingProgress('org', 'app')).toEqual({ fraction: 1 / 3, label: null });
    expect(onboardingProgress('org', 'web')).toEqual({ fraction: 1 / 5, label: null });
    expect(onboardingProgress('where', 'app')).toEqual({ fraction: 2 / 3, label: null });
    expect(onboardingProgress('where', 'web')).toEqual({ fraction: 2 / 5, label: null });
    expect(onboardingProgress('desktop', 'app')).toEqual({ fraction: 1, label: { current: 3, total: 3 } });
    expect(onboardingProgress('project', 'web')).toEqual({ fraction: 3 / 5, label: { current: 3, total: 5 } });
    expect(onboardingProgress('agent', 'web')).toEqual({ fraction: 4 / 5, label: { current: 4, total: 5 } });
    expect(onboardingProgress('connect', 'web')).toEqual({ fraction: 1, label: { current: 5, total: 5 } });
  });
});

describe('[SID:4668] AC1 — the fork after the organization, and the app way to «데스크톱 앱 받기»', () => {
  it('T1 the organization made → the fork screen, not the project step · bar only (no «n / n») · the app card chosen by default', async () => {
    await mountAndMakeOrg();
    // reverted (setStep('project') after the organization) → the h1 is «첫 프로젝트 만들기» and this fails
    expect(h1()).toBe(koMessages.onboarding.where.title);
    expect(container.textContent).not.toContain(koMessages.onboarding.createProject);
    expect(stepOf()).toBeNull();
    expect(barWidth()).toMatch(/^66\.6/); // app chosen → 2/3
    expect((container.querySelector('[data-testid=onboarding-where-app] input') as HTMLInputElement).checked).toBe(true);
    expect(byTestId('onboarding-where-not-mac')).toBeNull(); // a Mac — no «맥에서 받아요» line
  });

  it('T2 [계속] with the app chosen → «데스크톱 앱 받기» (3 / 3) with the download card · no project · agent · connect screen · nothing made', async () => {
    await mountAndMakeOrg();
    await click(byTestId('onboarding-where-continue'));
    // reverted (the app way going to the project step) → h1 «첫 프로젝트 만들기» and this fails
    expect(h1()).toBe(koMessages.onboarding.download.title);
    expect(stepOf()).toBe('3 / 3');
    expect(byTestId('desktop-download-card')).not.toBeNull();
    expect(byTestId('desktop-download-button')).not.toBeNull();
    expect(container.textContent).not.toContain(koMessages.onboarding.createProject);
    expect(container.textContent).not.toContain(koMessages.onboarding.createAgent);
    expect(container.textContent).not.toContain(koMessages.onboarding.connectSubtitle);
    expect(calls.filter((c) => c.url.endsWith('/api/projects'))).toHaveLength(0);
    expect(calls.filter((c) => c.url.endsWith('/api/team-members'))).toHaveLength(0);
  });

  it('T6 the app way is counted once as desktop_handoff_selected (the 3983 funnel\'s desktop signal) · the web way not', async () => {
    await mountAndMakeOrg();
    expect(eventsSent('desktop_handoff_selected')).toHaveLength(0);
    await click(byTestId('onboarding-where-continue'));
    expect(eventsSent('desktop_handoff_selected')).toHaveLength(1);
    expect(eventsSent('desktop_handoff_selected')[0]!.body).toMatchObject({ agent_id: null, meta: { flow: 'onboarding' } });
  });

  it('T7 not a Mac (a phone\'s browser): the «맥 앱은 맥에서 받아요» line under the app card, gone when the web card is chosen', async () => {
    setUserAgent(PHONE_UA);
    await mountAndMakeOrg();
    expect(byTestId('onboarding-where-not-mac')?.textContent).toBe(koMessages.onboarding.where.notMacNote);
    await chooseWeb();
    expect(byTestId('onboarding-where-not-mac')).toBeNull();
  });
});

describe('[SID:4668] AC2 — the web way keeps project → agent → connect · [건너뛰기] goes to the connect step', () => {
  it('T3 the web card + [계속] → «첫 프로젝트 만들기» 3 / 5 → agent 4 / 5 → connect 5 / 5 (the three steps as before)', async () => {
    await mountAndMakeOrg();
    await chooseWeb();
    expect(barWidth()).toBe('40%'); // the bar follows the chosen radio (web → 2/5)
    await click(byTestId('onboarding-where-continue'));
    expect(h1()).toBe(koMessages.onboarding.createProject);
    expect(stepOf()).toBe('3 / 5');

    await act(async () => { setNativeValue(container.querySelector('input') as HTMLInputElement, 'My Project'); });
    await click(buttonByText(koMessages.onboarding.createProjectAction));
    expect(h1()).toBe(koMessages.onboarding.createAgent);
    expect(stepOf()).toBe('4 / 5');

    await act(async () => { setNativeValue(container.querySelector('input') as HTMLInputElement, 'My Agent'); });
    await click(buttonByText(koMessages.onboarding.createAgentAction));
    expect(h1()).toBe(koMessages.onboarding.connectAgent);
    expect(stepOf()).toBe('5 / 5');
    expect(eventsSent('desktop_handoff_selected')).toHaveLength(0);
  });

  it('T4 [건너뛰기] at the agent step → the connect step with the app card (no home, no «발급 실패» line) · [에이전트 만들기] goes back', async () => {
    await mountAndMakeOrg();
    await chooseWeb();
    await click(byTestId('onboarding-where-continue'));
    await act(async () => { setNativeValue(container.querySelector('input') as HTMLInputElement, 'My Project'); });
    await click(buttonByText(koMessages.onboarding.createProjectAction));
    const refreshesBefore = calls.filter((c) => c.url.endsWith('/api/auth/refresh')).length;

    await click(buttonByText(koMessages.onboarding.skip));
    // reverted (onClick={handleFinish}) → finishToHome refreshes the token and leaves; no connect h1 — this fails
    expect(h1()).toBe(koMessages.onboarding.connectAgent);
    expect(stepOf()).toBe('5 / 5');
    expect(calls.filter((c) => c.url.endsWith('/api/auth/refresh'))).toHaveLength(refreshesBefore);
    expect(byTestId('connect-step-no-agent')?.textContent).toBe(koMessages.onboarding.connectNoAgent);
    expect(byTestId('connect-step-desktop-primary')).not.toBeNull();
    expect(byTestId('desktop-download-card')).not.toBeNull();
    expect(container.textContent).not.toContain(koMessages.onboarding.apiKeyFailedMembers);
    expect(container.textContent).not.toContain(koMessages.onboarding.transportHosted); // the web block needs an agent — hidden
    expect(container.textContent).not.toContain(koMessages.onboarding.firstInstructionCta);

    await click(byTestId('connect-step-make-agent'));
    expect(h1()).toBe(koMessages.onboarding.createAgent);
  });
});

describe('[SID:4668] AC3 — «데스크톱 앱 받기»: [다운로드] is the one primary button · the rest folded under «더 보기»', () => {
  async function toDownloadScreen() {
    await mountAndMakeOrg();
    await click(byTestId('onboarding-where-continue'));
    expect(h1()).toBe(koMessages.onboarding.download.title);
  }

  it('T5a exactly one primary control, and it is the card\'s [다운로드] · the card\'s own title is not drawn under the h1', async () => {
    await toDownloadScreen();
    const primaries = [...container.querySelectorAll('a, button')].filter((el) => el.className.includes('bg-primary'));
    // reverted (a hero [오늘로 가기] or the card title back) → two primaries / the title twice — this fails
    expect(primaries.map((el) => el.getAttribute('data-testid'))).toEqual(['desktop-download-button']);
    expect(byTestId('desktop-download-card')?.textContent).not.toContain(koMessages.desktop.title);
    expect(byTestId('onboarding-download-after-note')?.textContent).toBe(koMessages.onboarding.download.afterNote);
  });

  it('T5b «더 보기» is folded: no remote control · no way back until opened; opened → [갈림으로 돌아가기] returns to the fork', async () => {
    await toDownloadScreen();
    const more = byTestId('onboarding-download-more')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(byTestId('onboarding-download-more-panel')).toBeNull();
    expect(byTestId('onboarding-remote-control')).toBeNull();
    expect(byTestId('onboarding-download-back-to-choice')).toBeNull();

    await click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(byTestId('onboarding-download-more-panel')).not.toBeNull();
    expect(byTestId('onboarding-download-back-to-choice')?.textContent).toBe(koMessages.onboarding.download.backToChoice);

    await click(byTestId('onboarding-download-back-to-choice'));
    expect(h1()).toBe(koMessages.onboarding.where.title);
    expect(stepOf()).toBeNull();
  });

  it('T5c the way out is a text line with [오늘로 가기] — not a button in the hierarchy', async () => {
    await toDownloadScreen();
    expect(byTestId('onboarding-download-later')?.textContent).toContain(koMessages.onboarding.download.laterNote);
    const finish = byTestId('onboarding-download-finish');
    expect(finish?.textContent).toBe(koMessages.onboarding.desktopFinishToToday);
    expect(finish!.className).not.toContain('bg-primary');
  });
});
