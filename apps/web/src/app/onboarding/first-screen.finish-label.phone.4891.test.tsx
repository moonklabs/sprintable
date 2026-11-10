// @vitest-environment jsdom
//
// story 4891 (Kadir's note on PR 5488) — the phone app's own branch of the first screen draws the way out too (`inPhoneApp`: the Mac-or-not fork is not drawn, the phone's own screen takes its
// place, and the same «지금은 받지 않아도 돼요 … [..]» line follows it). The label test without a phone context never drew that branch, so a label change in it passed. This draws it:
// the way out names its landing here too (flag ON → Today · OFF → the dashboard word). Reverting `finishLabel` in the phone branch of first-screen.tsx turns the flag-off case red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('./advanced-connect', () => ({ AdvancedConnect: () => <div /> }));
vi.mock('@/components/desktop/phone-first-screen', () => ({ PhoneFirstScreen: () => <div data-testid="stub-phone-first" /> }));
vi.mock('@/components/providers/phone-bridge-context', () => ({ usePhoneBridge: () => ({ inPhoneApp: true }) }));

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
async function renderPhone(todayV3Enabled: boolean) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <FirstScreen orgId="org-1" chatsHref="/chats" todayHref="/today" todayV3Enabled={todayV3Enabled} orgName={null} onFinish={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  return {
    inPhoneBranch: !!container.querySelector('[data-testid="onboarding-first-phone-app"]'),
    labels: [...container.querySelectorAll('[data-testid="onboarding-first-finish"]')].map((b) => (b.textContent ?? '').trim()),
  };
}

describe('FirstScreen inside the phone app — the way out names its landing (story 4891)', () => {
  it('flag OFF: the dashboard word, not «오늘로 가기» — and it is the phone branch that was drawn', async () => {
    const { inPhoneBranch, labels } = await renderPhone(false);
    expect(inPhoneBranch).toBe(true);
    expect(labels).toEqual([onboarding.dashboardCta]);
  });

  it('flag ON: «오늘로 가기»', async () => {
    const { inPhoneBranch, labels } = await renderPhone(true);
    expect(inPhoneBranch).toBe(true);
    expect(labels).toEqual([onboarding.desktopFinishToToday]);
  });
});
