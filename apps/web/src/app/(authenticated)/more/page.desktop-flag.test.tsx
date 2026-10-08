// @vitest-environment jsdom
//
// story #4547 AC2 (Kadir 4930 곁) — the mobile «더보기» hub lists «데스크톱 앱» (/desktop) only while DESKTOP_DOWNLOAD_ENABLED is on:
// /desktop redirects when it is off, so a link there would lead nowhere (4524 · nav-config.ts `desktopItem`). Rendered for real —
// the flag read from the dashboard context, the rest of the flags as they are.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

let desktopDownloadEnabled = false;
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_BREAKPOINT: 1024 }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({
    navV3Flags: { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true, desktopDownloadEnabled },
    orgMemberships: [], projectMemberships: [],
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount() {
  const { default: MorePage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><MorePage /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
}

const desktopLinks = () => [...container.querySelectorAll('a')].filter((a) => a.getAttribute('href')?.split('?')[0] === '/desktop');

describe('[4547 AC2] «더보기» hub — «데스크톱 앱» only with the flag on', () => {
  it('on: one «데스크톱 앱» link to /desktop', async () => {
    desktopDownloadEnabled = true;
    await mount();
    const links = desktopLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toContain(koMessages.nav.desktopApp);
  });

  it('off: no link to /desktop and no «데스크톱 앱» anywhere in the hub', async () => {
    desktopDownloadEnabled = false;
    await mount();
    expect(desktopLinks()).toHaveLength(0);
    expect(container.textContent).not.toContain(koMessages.nav.desktopApp);
  });
});
