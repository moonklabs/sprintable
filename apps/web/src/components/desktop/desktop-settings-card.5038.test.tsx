// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { __resetDesktopAppForTest, desktopSettingsOf, type DesktopSettings } from '@/lib/desktop-app';
import { DesktopSettingsCard } from './desktop-settings-card';

// story 5038 (C8 · B 설정 칸 · web side): the app's own settings on /desktop — drawn only in the app that gives them (old app = no cell · new app = the cell), a switch shows what the app KEPT, a press writes ONE closed patch, a failed write changes nothing and says so.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const render = (locale: 'ko' | 'en' = 'ko') => act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC"><DesktopSettingsCard /></NextIntlClientProvider>); });
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const sw = (id: string) => q(`desktop-setting-${id}`)!.querySelector('[role=switch]') as HTMLElement;
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };
const SETTINGS: DesktopSettings = desktopSettingsOf({ kinds: { needs_hand: true, finished: true, failed: true }, thisComputerOff: false, dockBadge: true, trayIcon: true, keepRunning: false })!;
const withSettings = (over: Partial<Record<string, unknown>> = {}) => desktopSettingsOf({ ...SETTINGS, ...over })!;
let push: (s: unknown) => void = () => undefined;
const base = { inApp: true as const, device: Object.freeze({ name: '윤재의 MacBook' }), runtimes: Object.freeze([]), pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }) };
const newApp = (over: Record<string, unknown> = {}) => Object.freeze({
  ...base, settings: SETTINGS,
  setSettings: vi.fn(async (_p: unknown) => ({ ok: true as const, settings: SETTINGS })),
  subscribeSettings: (l: (s: unknown) => void) => { push = l; l(SETTINGS); return () => undefined; },
  ...over,
});
beforeEach(() => { __resetDesktopAppForTest(); setBridge(undefined); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); setBridge(undefined); __resetDesktopAppForTest(); });

describe('[SID:5038 C8] the desktop settings cell is drawn only where the app gives its settings', () => {
  it('⭐a browser (no bridge): no cell', async () => { await render(); expect(q('desktop-settings-card')).toBeNull(); });
  it('⭐an OLD app (a bridge with no settings at all): no cell — nothing empty is drawn', async () => { setBridge(Object.freeze({ ...base })); await render(); expect(q('desktop-settings-card')).toBeNull(); });
  it('an app with the value but no write hand (or no subscribe): no cell — a switch that cannot write is never drawn', async () => {
    setBridge(newApp({ setSettings: undefined })); await render(); expect(q('desktop-settings-card')).toBeNull();
    __resetDesktopAppForTest(); setBridge(newApp({ subscribeSettings: undefined })); await render(); expect(q('desktop-settings-card')).toBeNull();
  });
  it('an app whose settings are not the closed shape (a flag missing · a non-boolean): no cell', async () => {
    setBridge(newApp({ settings: { ...SETTINGS, dockBadge: 'yes' }, subscribeSettings: () => () => undefined })); await render(); expect(q('desktop-settings-card')).toBeNull();
  });
  it('⭐a NEW app: the cell with the seven switches, each showing the app\'s kept value', async () => {
    setBridge(newApp({ settings: withSettings({ keepRunning: true, trayIcon: false }), subscribeSettings: () => () => undefined })); await render();
    expect(q('desktop-settings-card')).not.toBeNull();
    const state = (id: string) => sw(id).getAttribute('aria-checked');
    for (const id of ['kind-needs_hand', 'kind-finished', 'kind-failed', 'dockBadge']) expect(state(id), id).toBe('true');
    for (const id of ['thisComputerOff', 'trayIcon']) expect(state(id), id).toBe('false');
    expect(state('keepRunning')).toBe('true');
    expect(container.querySelectorAll('[role=switch]').length).toBe(7);
  });
});

describe('[SID:5038 C8] the words (PO 11-27: the keep-on switch\'s name and note are the PO\'s own)', () => {
  it('⭐ko: «창을 닫아도 앱 켜 두기» + its note word for word; the other switches keep their names', async () => {
    setBridge(newApp()); await render();
    expect(q('desktop-setting-keepRunning')!.textContent).toContain('창을 닫아도 앱 켜 두기');
    expect(q('desktop-setting-keepRunning-note')!.textContent).toBe('알림 · 독 배지 · 메뉴 막대 아이콘이 계속 돼요. 에이전트는 이 설정과 상관없이 계속 일해요. 앱을 끝내려면 ⌘Q.');
    const text = container.textContent ?? '';
    for (const w of ['컴퓨터 알림', '내 손이 필요할 때', '일이 끝났을 때', '오류가 났을 때', '이 컴퓨터만 알림 끄기', '폰과 다른 컴퓨터의 알림은 그대로예요.', '독 아이콘에 내 손이 필요한 일 수 보기', '메뉴 막대에 아이콘 두기']) expect(text, w).toContain(w);
  });
  it('en has every word too (the same seven switches)', async () => {
    setBridge(newApp()); await render('en');
    expect(q('desktop-setting-keepRunning')!.textContent).toContain('Keep the app running when the window closes');
    expect(container.querySelectorAll('[role=switch]').length).toBe(7);
    expect(container.textContent).not.toMatch(/[가-힣]/);
  });
});

describe('[SID:5038 C8] a press writes ONE closed patch; the switch shows what the app kept', () => {
  const cases: Array<[string, unknown]> = [
    ['kind-needs_hand', { kinds: { needs_hand: false } }], ['kind-finished', { kinds: { finished: false } }], ['kind-failed', { kinds: { failed: false } }],
    ['thisComputerOff', { thisComputerOff: true }], ['dockBadge', { dockBadge: false }], ['trayIcon', { trayIcon: false }], ['keepRunning', { keepRunning: true }],
  ];
  for (const [id, patch] of cases) {
    it(`⭐${id}: one press → setSettings(${JSON.stringify(patch)}) and nothing else`, async () => {
      const b = newApp(); setBridge(b); await render();
      await act(async () => { sw(id).click(); });
      expect((b.setSettings as ReturnType<typeof vi.fn>).mock.calls).toEqual([[patch]]);
    });
  }
  it('⭐the app keeps what it keeps: it answers with a different value → the switch shows THAT, not what was asked', async () => {
    const kept = withSettings({ keepRunning: false });
    const b = newApp({ setSettings: vi.fn(async () => ({ ok: true as const, settings: kept })) }); setBridge(b); await render();
    await act(async () => { sw('keepRunning').click(); });
    expect(sw('keepRunning').getAttribute('aria-checked')).toBe('false');
    expect(q('desktop-settings-failed')!.textContent).toBe('');
  });
  it('⭐a write the app refuses (or that throws) leaves the switch as it was and says «바꾸지 못했어요 — 다시 시도해 주세요»', async () => {
    for (const fail of [async () => ({ ok: false as const, code: 'write_failed' }), async () => { throw new Error('gone'); }, async () => ({ ok: true as const, settings: { nonsense: 1 } })]) {
      __resetDesktopAppForTest(); setBridge(newApp({ setSettings: vi.fn(fail) })); await render();
      await act(async () => { sw('dockBadge').click(); });
      expect(sw('dockBadge').getAttribute('aria-checked')).toBe('true');
      expect(q('desktop-settings-failed')!.textContent).toBe('바꾸지 못했어요 — 다시 시도해 주세요');
    }
  });
  it('the next press clears the failed line (and a good write keeps it clear)', async () => {
    const fn = vi.fn().mockResolvedValueOnce({ ok: false, code: 'write_failed' }).mockResolvedValueOnce({ ok: true, settings: withSettings({ dockBadge: false }) });
    setBridge(newApp({ setSettings: fn })); await render();
    await act(async () => { sw('dockBadge').click(); });
    expect(q('desktop-settings-failed')!.textContent).not.toBe('');
    await act(async () => { sw('dockBadge').click(); });
    expect(q('desktop-settings-failed')!.textContent).toBe('');
    expect(sw('dockBadge').getAttribute('aria-checked')).toBe('false');
  });
  it('the switches are held while a write is on its way (no second press races the first)', async () => {
    let release: (v: unknown) => void = () => undefined;
    const b = newApp({ setSettings: vi.fn(() => new Promise((r) => { release = r; })) }); setBridge(b); await render();
    await act(async () => { sw('trayIcon').click(); });
    expect(container.querySelectorAll('[role=switch][data-disabled]').length).toBe(7);
    await act(async () => { sw('dockBadge').click(); });
    expect((b.setSettings as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    await act(async () => { release({ ok: true, settings: withSettings({ trayIcon: false }) }); });
    expect(container.querySelectorAll('[role=switch][data-disabled]').length).toBe(0);
  });
});

describe('[SID:5038 C8] the app changes its settings (the menu · another window): the cell follows', () => {
  it('⭐a pushed settings makes the switches follow; a pushed value off the closed shape is ignored', async () => {
    setBridge(newApp()); await render();
    expect(sw('keepRunning').getAttribute('aria-checked')).toBe('false');
    await act(async () => { push(withSettings({ keepRunning: true })); });
    expect(sw('keepRunning').getAttribute('aria-checked')).toBe('true');
    await act(async () => { push({ nonsense: true }); });
    expect(sw('keepRunning').getAttribute('aria-checked')).toBe('true');
  });
});
