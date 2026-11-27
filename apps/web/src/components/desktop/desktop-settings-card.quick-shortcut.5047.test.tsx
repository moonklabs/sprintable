// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { __resetDesktopAppForTest, desktopSettingsOf, type DesktopSettings } from '@/lib/desktop-app';
import { DesktopSettingsCard } from './desktop-settings-card';

// story 5047 (C14 · ①): the quick-ask shortcut row INSIDE the desktop settings card — drawn only when the app gives the value AND the hand (an older app · a test build: no row, the rest of the card unchanged).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const render = () => act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><DesktopSettingsCard /></NextIntlClientProvider>); });
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };
const SETTINGS: DesktopSettings = desktopSettingsOf({ kinds: { needs_hand: true, finished: true, failed: true }, thisComputerOff: false, dockBadge: true, trayIcon: true, keepRunning: false })!;
const base = { inApp: true as const, device: Object.freeze({ name: '윤재의 MacBook' }), runtimes: Object.freeze([]), pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }) };
const VIEW = Object.freeze({ accelerator: 'Alt+Space', label: '⌥Space', status: 'registered' as const });
const app = (over: Record<string, unknown> = {}) => Object.freeze({
  ...base, settings: SETTINGS,
  setSettings: vi.fn(async (_p: unknown) => ({ ok: true as const, settings: SETTINGS })),
  subscribeSettings: (l: (s: unknown) => void) => { l(SETTINGS); return () => undefined; },
  ...over,
});
beforeEach(() => { __resetDesktopAppForTest(); setBridge(undefined); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); setBridge(undefined); __resetDesktopAppForTest(); });

describe('[SID:5047 C14 ①] the shortcut row lives in the settings card only where the app gives it', () => {
  it('⭐an app with the value and the hand: the row is in the card, saying the key, beside the seven switches', async () => {
    setBridge(app({ quickAskShortcut: VIEW, setQuickAskShortcut: vi.fn(async () => ({ ok: true as const, shortcut: VIEW })) }));
    await render();
    expect(q('desktop-settings-card')).not.toBeNull();
    expect(q('quick-shortcut-row')).not.toBeNull();
    expect(q('quick-shortcut-label')!.textContent).toContain('⌥Space');
    expect(container.querySelectorAll('[role=switch]').length).toBe(7);
    expect(q('desktop-settings-card')!.contains(q('quick-shortcut-row'))).toBe(true);
  });

  it('⭐a card app WITHOUT the quick-ask pair (an older app · a test build): the card as before, no row', async () => {
    setBridge(app());
    await render();
    expect(q('desktop-settings-card')).not.toBeNull();
    expect(q('quick-shortcut-row')).toBeNull();
    expect(container.querySelectorAll('[role=switch]').length).toBe(7);
  });

  it('the value without the hand, or the hand without the value: no row (a key that cannot be changed is not offered; a change with nothing to show is not either)', async () => {
    setBridge(app({ quickAskShortcut: VIEW })); await render(); expect(q('quick-shortcut-row')).toBeNull();
    __resetDesktopAppForTest(); setBridge(app({ setQuickAskShortcut: vi.fn() })); await render(); expect(q('quick-shortcut-row')).toBeNull();
  });

  it('a value that is not the closed shape: no row', async () => {
    setBridge(app({ quickAskShortcut: { accelerator: 'Alt+Space', label: '⌥Space', status: 'happy' }, setQuickAskShortcut: vi.fn() }));
    await render();
    expect(q('quick-shortcut-row')).toBeNull();
  });

  it('a press of «바꾸기» opens the listening line inside the card, and the switches keep working (the row is a neighbour, not a replacement)', async () => {
    const setSettings = vi.fn(async (_p: unknown) => ({ ok: true as const, settings: SETTINGS }));
    setBridge(app({ setSettings, quickAskShortcut: VIEW, setQuickAskShortcut: vi.fn() }));
    await render();
    await act(async () => { (q('quick-shortcut-change') as HTMLElement).click(); });
    expect(q('quick-shortcut-listening')).not.toBeNull();
    await act(async () => { (q('desktop-setting-dockBadge')!.querySelector('[role=switch]') as HTMLElement).click(); });
    expect(setSettings).toHaveBeenCalledTimes(1);
  });
});
