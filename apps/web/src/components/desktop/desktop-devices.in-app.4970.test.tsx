// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { __resetDesktopAppForTest } from '@/lib/desktop-app';
import { DesktopDevices } from './desktop-devices';

// story 4970 (PO 11-16): inside the desktop app the «연결된 기기» empty state must not say «위에서 데스크톱 앱을 받아 …» — the person has the app, and the card above says «연결됨». The same sentence without that
// clause there; in a browser it is what it was. «Inside the app» is the one mark `window.sprintableDesktop.inApp` (desktopApp()), never a user-agent guess (the app runs on a Mac: the cases keep a Mac user agent ON).
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
let container: HTMLDivElement;
let root: Root;
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };
const bridge = Object.freeze({
  inApp: true as const, device: Object.freeze({ name: 'mac' }), runtimes: Object.freeze([]),
  pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }),
});
const draw = async (locale: 'ko' | 'en') => {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><DesktopDevices /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const emptyText = () => container.querySelector('[data-testid="desktop-devices-empty"]')?.textContent ?? null;

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => MAC);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: 'o', orgSlug: 'o', role: 'owner' }], projectMemberships: [], userName: 'u' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ computers: [], truncated: false }), { status: 200 })));
  __resetDesktopAppForTest(); setBridge(undefined);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = '';
  setBridge(undefined); __resetDesktopAppForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('story 4970 — the «연결된 기기» empty state', () => {
  it('in a browser: the line is what it was (ko · en)', async () => {
    await draw('ko'); expect(emptyText()).toContain(koMessages.desktop.devices.emptyBody);
    await draw('en'); expect(emptyText()).toContain(enMessages.desktop.devices.emptyBody);
  });

  it('in the app (Mac user agent on): the same sentence without «위에서 데스크톱 앱을 받아» · «Download the desktop app above» (ko · en)', async () => {
    setBridge(bridge);
    await draw('ko');
    expect(emptyText()).toContain(koMessages.desktop.devices.emptyBodyInApp);
    expect(emptyText()).not.toContain('받아');
    expect(emptyText()).toContain(koMessages.desktop.devices.emptyTitle); // the title is as it was
    await draw('en');
    expect(emptyText()).toContain(enMessages.desktop.devices.emptyBodyInApp);
    expect(emptyText()!.toLowerCase()).not.toContain('download');
  });

  it('the in-app line is the old one with the «get the app» clause taken out — nothing else is said', () => {
    expect(koMessages.desktop.devices.emptyBodyInApp).toBe('설정을 마치면 이 조직의 기기가 여기에 보여요.');
    expect(koMessages.desktop.devices.emptyBody.endsWith(koMessages.desktop.devices.emptyBodyInApp)).toBe(true);
    expect(enMessages.desktop.devices.emptyBody.toLowerCase()).toContain('finish its setup');
    expect(enMessages.desktop.devices.emptyBodyInApp).toContain("your organization's devices will show up here.");
  });
});
