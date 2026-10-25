// @vitest-environment jsdom
// story 4763 AC14 — the «앱 먼저» customer path: login screen «Mac 앱 받기» → the Mac app → sign-up. An organization-less account that signs in INSIDE the app reached this screen and was shown
// the download card («Mac 앱 받기 · 앱 열기 · 이 창은 닫아도 돼요») — for someone who has no app yet. Inside the app the next step is the app's own setup page; in a browser nothing changes.
// Reverting the `inMacApp` branch in first-screen.tsx (the replace to the setup page or the card's removal) turns this red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('./advanced-connect', () => ({ AdvancedConnect: () => <div data-testid="stub-advanced" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { FirstScreen, DESKTOP_SETUP_PATH } = await import('./first-screen');

// the bridge the app's preload gives a page on our origin (apps/web/src/lib/desktop-app.ts `desktopAppOf` checks this shape)
const bridge = () => ({
  inApp: true as const,
  device: { name: 'SYJ-MacBook-Pro' },
  runtimes: [],
  pickFolder: async () => null,
  startHere: async () => ({ ok: true as const }),
  setProjectFolder: async () => ({ ok: true as const }),
});

let container: HTMLDivElement;
let root: Root;
let replace: ReturnType<typeof vi.fn>;
const originalLocation = window.location;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  replace = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, replace } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) })));
  // a Mac browser: the page draws the Mac download card (`notAMac` reads the user agent) — so «no card inside the app» is a real difference, not a Linux jsdom that never drew one
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { sprintableDesktop?: unknown }).sprintableDesktop;
  delete (navigator as { userAgent?: string }).userAgent;
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <FirstScreen orgId="org-1" chatsHref="/chats" orgName="MinhFour의 조직" onFinish={vi.fn()} />
      </NextIntlClientProvider>,
    );
  });
};
const has = (id: string) => !!container.querySelector(`[data-testid="${id}"]`);

describe('FirstScreen inside the Mac app (story 4763 AC14)', () => {
  it('goes to the app\'s setup page once, and draws no download card', async () => {
    (window as { sprintableDesktop?: unknown }).sprintableDesktop = bridge();
    await render();
    expect(DESKTOP_SETUP_PATH).toBe('/desktop/setup');
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/desktop/setup');
    expect(has('onboarding-first-mac')).toBe(false);
    expect(has('onboarding-first-open-app')).toBe(false);
    expect(container.textContent).not.toContain('에이전트는 내 Mac에서 돌아가요');
  });

  it('in a browser (no bridge) nothing changes: the download card, the open-the-app link, the finish link; no navigation', async () => {
    await render();
    expect(replace).not.toHaveBeenCalled();
    expect(has('onboarding-first-mac')).toBe(true);
    expect(has('onboarding-first-open-app')).toBe(true);
    expect(container.textContent).toContain('에이전트는 내 Mac에서 돌아가요'); // the Mac title of the card (the card's own button text waits for the download info, which the stubbed fetch does not give)
    expect(has('onboarding-first-finish')).toBe(true);
  });

  it('a page whose bridge is not the app\'s shape (anything else on window) is a browser: no navigation', async () => {
    (window as { sprintableDesktop?: unknown }).sprintableDesktop = { inApp: true };
    await render();
    expect(replace).not.toHaveBeenCalled();
    expect(has('onboarding-first-mac')).toBe(true);
    expect(has('onboarding-first-finish')).toBe(true);
  });
});
