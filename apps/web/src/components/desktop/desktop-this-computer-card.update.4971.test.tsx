// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { __resetDesktopAppForTest, desktopApp } from '@/lib/desktop-app';
import { DesktopThisComputerCard } from './desktop-this-computer-card';

// story 4971 ③: inside the desktop app the «이 컴퓨터» card says when a newer build exists — «새 판 0.2.x · 지금 업데이트» — and ONE press hands it to the app (which downloads, checks and restarts).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const render = (locale: 'ko' | 'en' = 'ko') => act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC"><DesktopThisComputerCard bridge={desktopApp()!} /></NextIntlClientProvider>); });
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };
let push: (o: unknown) => void = () => undefined;
const bridge = (over: Record<string, unknown> = {}) => Object.freeze({
  // the real preload replays the CURRENT offer at once (the same one `update` carried at load) — not null
  inApp: true as const, device: Object.freeze({ name: '윤재의 MacBook' }), appVersion: '0.2.149', runtimes: Object.freeze([]),
  pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }),
  startUpdate: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  subscribeUpdate: (l: (o: unknown) => void) => { push = l; l(over.update ?? null); return () => undefined; },
  ...over,
});
beforeEach(() => { __resetDesktopAppForTest(); setBridge(undefined); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); setBridge(undefined); __resetDesktopAppForTest(); });

describe('[SID:4971 ③] the «이 컴퓨터» card and the update line', () => {
  it('nothing on offer: no update line (the card is what 4970 made it)', async () => {
    setBridge(bridge());
    await render();
    expect(q('desktop-this-computer-card')).not.toBeNull();
    expect(q('desktop-update-line')).toBeNull();
  });
  it('a newer build on offer: «새 판 0.2.150» and [지금 업데이트]; one press calls the app\'s startUpdate with no argument', async () => {
    const b = bridge({ update: { version: '0.2.150', phase: 'available' } });
    setBridge(b);
    await render();
    expect(q('desktop-update-text')?.textContent).toBe(koMessages.desktop.updateAvailable.replace('{version}', '0.2.150'));
    const btn = q('desktop-update-button') as HTMLButtonElement;
    expect(btn.textContent).toBe(koMessages.desktop.updateNow);
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.click(); await Promise.resolve(); });
    expect((b.startUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual([[]]);
  });
  it('the app pushes the phases live: downloading and installing say so with no button; failed offers «다시 시도» (and a press tries again)', async () => {
    const b = bridge({ update: { version: '0.2.150', phase: 'available' } });
    setBridge(b);
    await render();
    await act(async () => { push({ version: '0.2.150', phase: 'downloading' }); });
    expect(q('desktop-update-text')?.textContent).toBe(koMessages.desktop.updateDownloading.replace('{version}', '0.2.150'));
    expect(q('desktop-update-button')).toBeNull();
    await act(async () => { push({ version: '0.2.150', phase: 'installing' }); });
    expect(q('desktop-update-text')?.textContent).toBe(koMessages.desktop.updateInstalling.replace('{version}', '0.2.150'));
    expect(q('desktop-update-button')).toBeNull();
    await act(async () => { push({ version: '0.2.150', phase: 'failed' }); });
    expect(q('desktop-update-text')?.textContent).toBe(koMessages.desktop.updateFailed.replace('{version}', '0.2.150'));
    const retry = q('desktop-update-button') as HTMLButtonElement;
    expect(retry.textContent).toBe(koMessages.desktop.updateRetry);
    await act(async () => { retry.click(); await Promise.resolve(); });
    expect((b.startUpdate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await act(async () => { push(null); });
    expect(q('desktop-update-line')).toBeNull();
  });
  it('a press is not repeated while it is in flight (the button is off until the app answers)', async () => {
    let answer: (v: { ok: true }) => void = () => undefined;
    const startUpdate = vi.fn(() => new Promise<{ ok: true }>((r) => { answer = r; }));
    setBridge(bridge({ update: { version: '0.2.150', phase: 'available' }, startUpdate }));
    await render();
    const btn = q('desktop-update-button') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect((q('desktop-update-button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (q('desktop-update-button') as HTMLButtonElement).click(); });
    expect(startUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: true }); await Promise.resolve(); });
  });
  it('an offer off the closed shape draws nothing; an app that cannot press (no startUpdate) shows the notice with the button off', async () => {
    setBridge(bridge({ update: { version: 'latest', phase: 'available' } }));
    await render();
    expect(q('desktop-update-line')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    __resetDesktopAppForTest();
    const { startUpdate: _s, ...noPress } = bridge({ update: { version: '0.2.150', phase: 'available' } });
    setBridge(Object.freeze(noPress));
    await render();
    expect(q('desktop-update-text')).not.toBeNull();
    expect((q('desktop-update-button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('English words follow the page language', async () => {
    setBridge(bridge({ update: { version: '0.2.150', phase: 'available' } }));
    await render('en');
    expect(q('desktop-update-text')?.textContent).toBe(enMessages.desktop.updateAvailable.replace('{version}', '0.2.150'));
    expect(q('desktop-update-button')?.textContent).toBe(enMessages.desktop.updateNow);
  });
});
