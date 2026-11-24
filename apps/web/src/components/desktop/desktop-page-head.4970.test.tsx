// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { __resetDesktopAppForTest } from '@/lib/desktop-app';
import { DesktopPageHead } from './desktop-page-head';

// story 4970 (PO 11-16): inside the desktop app the «데스크톱 앱» screen's one line must not talk about GETTING the app («앱을 열고 받는 일, …») — the same sentence without that clause.
// Outside the app (a browser · the phone) the line is what it was. «Inside the app» is the one mark `window.sprintableDesktop.inApp` (desktopApp()), never a user-agent guess.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };
const bridge = Object.freeze({
  inApp: true as const, device: Object.freeze({ name: 'mac' }), runtimes: Object.freeze([]),
  pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }),
});
const draw = async (locale: 'ko' | 'en') => {
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC"><DesktopPageHead /></NextIntlClientProvider>); });
};
const line = () => container.querySelector('[data-testid="desktop-page-head"] p')!.textContent;

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
beforeEach(() => { vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => MAC); __resetDesktopAppForTest(); setBridge(undefined); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); setBridge(undefined); __resetDesktopAppForTest(); vi.restoreAllMocks(); });

describe('story 4970 — the desktop screen\'s head line', () => {
  it('in a browser: the line is what it was (ko · en)', async () => {
    await draw('ko'); expect(line()).toBe(koMessages.desktop.pageNote);
    await draw('en'); expect(line()).toBe(enMessages.desktop.pageNote);
  });

  it('in the app: the same sentence without the «getting the app» clause (ko · en) — never the browser line', async () => {
    setBridge(bridge);
    await draw('ko');
    expect(line()).toBe(koMessages.desktop.pageNoteInApp);
    expect(line()).not.toContain('받는');
    expect(line()).not.toBe(koMessages.desktop.pageNote);
    await draw('en');
    expect(line()).toBe(enMessages.desktop.pageNoteInApp);
    expect(line()!.toLowerCase()).not.toMatch(/\bget the app\b|\bor get\b/);
  });

  it('the in-app line says nothing the browser line did not (it is that sentence shortened — the two remaining clauses stay, in the same words)', () => {
    for (const m of [koMessages, enMessages]) {
      const tail = (m.desktop.pageNoteInApp).replace(/[.]$/, '');
      const parts = tail.split(/,| and /).map((s) => s.trim()).filter(Boolean);
      expect(parts.length).toBeGreaterThanOrEqual(2);
    }
    expect(koMessages.desktop.pageNote).toContain('폰으로 원격 제어하는 일, 연결된 기기를 보는 일을 한 화면에 모았어요');
    expect(koMessages.desktop.pageNoteInApp).toBe('폰으로 원격 제어하는 일, 연결된 기기를 보는 일을 한 화면에 모았어요.');
  });
});
