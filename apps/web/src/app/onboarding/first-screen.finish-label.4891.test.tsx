// @vitest-environment jsdom
//
// story 4891 — the first screen's way out says where it lands. The landing is resolveOnboardingLandingHref (flag ON → «오늘» · OFF → «대화»); the word was «오늘로 가기» always,
// so on a build with the flag off «Go to Today» landed on the chats page (measured on dev: web + phone width). Now it follows the flag, like the three other onboarding exits.
// Reverting `finishLabel` in first-screen.tsx to the fixed «오늘로 가기» turns the flag-off test red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('./advanced-connect', () => ({ AdvancedConnect: () => <div /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { FirstScreen } = await import('./first-screen');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) })));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const onboarding = (koMessages as unknown as { onboarding: Record<string, string> }).onboarding;
async function renderWith(todayV3Enabled: boolean) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <FirstScreen orgId="org-1" chatsHref="/chats" todayHref="/today" todayV3Enabled={todayV3Enabled} orgName={null} onFinish={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  return [...container.querySelectorAll('[data-testid="onboarding-first-finish"]')].map((b) => (b.textContent ?? '').trim());
}

describe('FirstScreen — the way out names its landing (story 4891)', () => {
  it('flag OFF (it lands on «대화»): the word is the dashboard word, not «오늘로 가기»', async () => {
    const labels = await renderWith(false);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) { expect(l).toBe(onboarding.dashboardCta); expect(l).not.toBe(onboarding.desktopFinishToToday); }
  });

  it('flag ON (it lands on «오늘»): «오늘로 가기»', async () => {
    const labels = await renderWith(true);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l).toBe(onboarding.desktopFinishToToday);
  });
});

// The word is the landing screen's MENU NAME (story 4891, PO): flag OFF lands on «대화»/«Chats», so the label carries that nav word in both languages and never the old
// «dashboard» word (there is no such screen in the menu). Land somewhere else without changing the label — or the reverse — and this goes red.
describe('the flag-off way-out word is the landing screen\'s menu name, in both languages', () => {
  const pairs = [['ko', koMessages], ['en', enMessages]] as const;
  for (const [lang, msgs] of pairs) {
    it(`${lang}: onboarding.dashboardCta contains nav.chats and not nav.dashboard`, () => {
      const m = msgs as unknown as { nav: Record<string, string>; onboarding: Record<string, string> };
      expect(m.onboarding.dashboardCta).toContain(m.nav.chats);
      expect(m.onboarding.dashboardCta).not.toContain(m.nav.dashboard);
    });
  }
});
