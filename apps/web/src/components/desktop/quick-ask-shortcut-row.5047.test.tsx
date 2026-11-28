// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { __resetDesktopAppForTest, type SprintableDesktop } from '@/lib/desktop-app';
import { QuickAskShortcutRow } from './quick-ask-shortcut-row';

// story 5047 (C14 · PO 11-27): the quick-ask shortcut's row — the key now, where it stands, [바꾸기] → listen for the next key → send the TEXT to the app → say what the app answered (the old key stays when the new one is refused).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const q = enMessages.desktop.appSettings.quickAsk;
const k = koMessages.desktop.appSettings.quickAsk;

const VIEW = { accelerator: 'Alt+Space', label: '⌥Space', status: 'registered' } as const;
let container: HTMLDivElement;
let root: Root;
const el = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); }); };
const bridgeOf = (set: (a: string) => Promise<unknown>, view: unknown = VIEW) => Object.freeze({ inApp: true, quickAskShortcut: view, setQuickAskShortcut: vi.fn(set) }) as unknown as SprintableDesktop;
async function mount(b: SprintableDesktop, locale: 'ko' | 'en' = 'ko') {
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC"><QuickAskShortcutRow bridge={b} /></NextIntlClientProvider>); });
}
const keydown = (code: string, init: KeyboardEventInit = {}) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...init })); });
const press = async (testId: string) => { await act(async () => { el(testId)!.click(); }); };

beforeEach(() => { __resetDesktopAppForTest(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); __resetDesktopAppForTest(); });

describe('[SID:5047] the row draws what the app says', () => {
  it('the key now and where it stands (ko)', async () => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW })));
    expect(el('quick-shortcut-label')!.textContent).toBe('지금 키: ⌥Space');
    expect(el('quick-shortcut-status')!.textContent).toBe(k.statusRegistered);
  });

  it.each([['conflict', 'statusConflict'], ['failed', 'statusFailed'], ['off', 'statusOff']] as const)('%s is said in words (and not only by a colour)', async (status, key) => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW }), { ...VIEW, status }));
    expect(el('quick-shortcut-status')!.textContent).toBe(k[key]);
  });

  it('an app with no shortcut (or a value not in the shape) draws nothing', async () => {
    await mount(Object.freeze({ inApp: true }) as unknown as SprintableDesktop);
    expect(el('quick-shortcut-row')).toBeNull();
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW }), { accelerator: '', label: '', status: 'x' }));
    expect(el('quick-shortcut-row')).toBeNull();
  });

  it('English reads the same story', async () => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW })), 'en');
    expect(el('quick-shortcut-label')!.textContent).toBe('Key now: ⌥Space');
    await press('quick-shortcut-change');
    expect(el('quick-shortcut-listening')!.textContent).toBe(q.listening);
  });
});

describe('[SID:5047 · C14 ⓐ] the row promises only what the Mac can tell: another app\'s key is not announced, a quiet key gets a hint', () => {
  // measured on build 0.2.418 (the Mac measurement, PO 11-28): macOS does not tell an app that ANOTHER app holds a key — a «conflict» is only the app's own duplicate. So no line says «another app already uses it»;
  // the one thing said for a registered key is what a person can act on: nothing opens → another app may be using it → pick another key.
  const claim = (m: Record<string, unknown>) => Object.entries(m).filter(([, v]) => typeof v === 'string' && /다른 앱이 이미|already uses/.test(v as string)).map(([key]) => key);
  it('no line of the shortcut\'s copy says another app already uses the key (ko · en)', () => {
    expect(claim(k as unknown as Record<string, unknown>)).toEqual([]);
    expect(claim(q as unknown as Record<string, unknown>)).toEqual([]);
  });
  it('a registered key carries the hint (ko · en)', async () => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW })));
    expect(el('quick-shortcut-hint')!.textContent).toBe(k.registeredHint);
    expect(k.registeredHint).toMatch(/다른 앱이 이 키를 쓰는 중일 수 있어요/);
  });
  it('the hint is English in English', async () => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW })), 'en');
    expect(el('quick-shortcut-hint')!.textContent).toBe(q.registeredHint);
  });
  it.each(['conflict', 'failed', 'off'] as const)('a key that is %s (not registered) carries no hint — it would say «nothing opens» about a key that is already said not to work', async (status) => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW }), { ...VIEW, status }));
    expect(el('quick-shortcut-status')).not.toBeNull();
    expect(el('quick-shortcut-hint')).toBeNull();
  });
  it('the refused-key lines still say the old key stays', () => {
    expect(k.conflictTried).toMatch(/지금 키는 그대로예요/);
    expect(q.conflictTried).toMatch(/unchanged/);
  });
});

describe('[SID:5047] changing it', () => {
  it('[바꾸기] listens: the line says «새 키를 눌러 주세요 · Esc로 취소»; Esc cancels and nothing is sent', async () => {
    const b = bridgeOf(async () => ({ ok: true, shortcut: VIEW }));
    await mount(b);
    await press('quick-shortcut-change');
    expect(el('quick-shortcut-listening')!.textContent).toBe(k.listening);
    await keydown('Escape');
    expect(el('quick-shortcut-listening')).toBeNull();
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
  });

  it('[취소] stops listening too', async () => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW })));
    await press('quick-shortcut-change');
    await press('quick-shortcut-cancel');
    expect(el('quick-shortcut-listening')).toBeNull();
  });

  it('a modifier alone waits for the key; the next key combination goes to the app AS TEXT; the row then shows what the app KEPT («바꿨어요»)', async () => {
    const kept = { accelerator: 'Alt+K', label: '⌥K', status: 'registered' };
    const b = bridgeOf(async () => ({ ok: true, shortcut: kept }));
    await mount(b);
    await press('quick-shortcut-change');
    await keydown('AltLeft', { altKey: true });
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
    await keydown('KeyK', { altKey: true, key: '˚' });
    await flush();
    expect((b.setQuickAskShortcut as ReturnType<typeof vi.fn>).mock.calls).toEqual([['Alt+K']]);
    expect(el('quick-shortcut-label')!.textContent).toBe('지금 키: ⌥K');
    expect(el('quick-shortcut-line')!.textContent).toContain(k.saved);
    expect(el('quick-shortcut-listening')).toBeNull();
  });

  it('a key another app holds: the app refuses and keeps the OLD key — the row still shows the old key and says so (reverted → the row shows the key that was asked for)', async () => {
    await mount(bridgeOf(async () => ({ ok: false, code: 'conflict', shortcut: VIEW })));
    await press('quick-shortcut-change');
    await keydown('KeyK', { altKey: true });
    await flush();
    expect(el('quick-shortcut-label')!.textContent).toBe('지금 키: ⌥Space');
    expect(el('quick-shortcut-line')!.textContent).toContain(k.conflictTried);
  });

  it('a key that is not a shortcut (the app says «invalid»): the old key stays, the words say what is needed', async () => {
    await mount(bridgeOf(async () => ({ ok: false, code: 'invalid', shortcut: VIEW })));
    await press('quick-shortcut-change');
    await keydown('KeyK');
    await flush();
    expect(el('quick-shortcut-label')!.textContent).toBe('지금 키: ⌥Space');
    expect(el('quick-shortcut-line')!.textContent).toContain(k.invalid);
  });

  it('nothing usable came back (the call threw): «바꿀 수 없어요 · 지금 키는 그대로예요» and the old key stays', async () => {
    await mount(bridgeOf(async () => { throw new Error('gone'); }));
    await press('quick-shortcut-change');
    await keydown('KeyK', { altKey: true });
    await flush();
    expect(el('quick-shortcut-label')!.textContent).toBe('지금 키: ⌥Space');
    expect(el('quick-shortcut-line')!.textContent).toContain(k.failedTried);
  });

  it('the keys are taken by the row while it listens (not passed on to the page); when it does not listen, keys are not touched', async () => {
    await mount(bridgeOf(async () => ({ ok: true, shortcut: VIEW })));
    const free = new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', cancelable: true });
    window.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
    await press('quick-shortcut-change');
    const taken = new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', altKey: true, cancelable: true });
    await act(async () => { window.dispatchEvent(taken); });
    expect(taken.defaultPrevented).toBe(true);
  });

  it('the listening stops with the row (no key listener is left behind)', async () => {
    const b = bridgeOf(async () => ({ ok: true, shortcut: VIEW }));
    await mount(b);
    await press('quick-shortcut-change');
    await act(async () => { root.render(<div />); });
    await keydown('KeyK', { altKey: true });
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
  });
});

describe('[SID:5047] a refusal still tells what the app KEPT', () => {
  it('⭐the row was «failed»; the app refuses the new key and says the old one is registered now → the row shows what the app says (reverted → the row keeps its old picture)', async () => {
    await mount(bridgeOf(async () => ({ ok: false, code: 'conflict', shortcut: VIEW }), { ...VIEW, status: 'failed' }));
    expect(el('quick-shortcut-status')!.textContent).toBe(k.statusFailed);
    await press('quick-shortcut-change');
    await keydown('KeyK', { altKey: true });
    await flush();
    expect(el('quick-shortcut-status')!.textContent).toBe(k.statusRegistered);
    expect(el('quick-shortcut-line')!.textContent).toContain(k.conflictTried);
  });
});

describe('[SID:5047] codex round: the listening row keeps the keyboard, the window and the unmount safe', () => {
  const okBridge = () => bridgeOf(async () => ({ ok: true, shortcut: VIEW }));
  const keyEvent = (code: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...init });

  it('⭐Tab · Enter · Space with no modifier keep their own job (the page does not take them): a keyboard person can still press [취소] (reverted → every key is swallowed and only Esc leaves)', async () => {
    const b = okBridge();
    await mount(b);
    await press('quick-shortcut-change');
    for (const code of ['Tab', 'Enter', 'Space']) {
      const e = keyEvent(code);
      await act(async () => { window.dispatchEvent(e); });
      expect(e.defaultPrevented, code).toBe(false);
    }
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
    expect(el('quick-shortcut-listening')).not.toBeNull(); // still listening: only [취소] / Esc ends it
    // …but WITH a modifier it is a shortcut candidate (Alt+Space is the default itself)
    await keydown('Space', { altKey: true });
    await flush();
    expect((b.setQuickAskShortcut as ReturnType<typeof vi.fn>).mock.calls).toEqual([['Alt+Space']]);
  });

  it('⭐a held key is one press: the auto-repeat of a combination is not a second answer (and is still kept from the page)', async () => {
    const b = okBridge();
    await mount(b);
    await press('quick-shortcut-change');
    const e = keyEvent('KeyK', { altKey: true, repeat: true });
    await act(async () => { window.dispatchEvent(e); });
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(el('quick-shortcut-listening')).not.toBeNull();
  });

  it('a key that belongs to an input method (composing · keyCode 229) is not a shortcut', async () => {
    const b = okBridge();
    await mount(b);
    await press('quick-shortcut-change');
    await act(async () => { window.dispatchEvent(keyEvent('KeyK', { altKey: true, keyCode: 229 })); });
    await act(async () => { window.dispatchEvent(keyEvent('KeyK', { altKey: true, isComposing: true })); });
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
  });

  it('⭐leaving the window ends the listening (the first key pressed after coming back is not an answer)', async () => {
    const b = okBridge();
    await mount(b);
    await press('quick-shortcut-change');
    await act(async () => { window.dispatchEvent(new Event('blur')); });
    expect(el('quick-shortcut-listening')).toBeNull();
    await keydown('KeyK', { altKey: true });
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
  });

  it('a key the app has no name for (a numpad key) is said in words — never a silent miss — and nothing is sent', async () => {
    const b = okBridge();
    await mount(b);
    await press('quick-shortcut-change');
    await keydown('Numpad1', { altKey: true });
    expect(b.setQuickAskShortcut).not.toHaveBeenCalled();
    expect(el('quick-shortcut-listening')).toBeNull();
    expect(el('quick-shortcut-line')!.textContent).toContain(k.invalid);
  });

  it('⭐a hand that never answers ends as «no answer» after the wait (the row is not busy for good)', async () => {
    vi.useFakeTimers();
    try {
      const b = bridgeOf(() => new Promise(() => undefined));
      await mount(b);
      await press('quick-shortcut-change');
      await keydown('KeyK', { altKey: true });
      expect(el('quick-shortcut-change')).toBeNull(); // busy
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
      expect(el('quick-shortcut-change')).not.toBeNull();
      expect(el('quick-shortcut-line')!.textContent).toContain(k.failedTried);
    } finally { vi.useRealTimers(); }
  });

  it('⭐an answer that comes after the row is gone draws nothing and raises nothing (no stale update)', async () => {
    let answer: (v: unknown) => void = () => undefined;
    const b = bridgeOf(() => new Promise((res) => { answer = res; }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await mount(b);
      await press('quick-shortcut-change');
      await keydown('KeyK', { altKey: true });
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      answer({ ok: true, shortcut: { accelerator: 'Alt+K', label: '⌥K', status: 'registered' } });
      await flush();
      expect(spy).not.toHaveBeenCalled();
      expect(el('quick-shortcut-row')).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('⭐after the listening ends the keyboard lands back on [바꾸기]; both buttons carry a name that says what they change', async () => {
    await mount(okBridge(), 'en');
    expect(el('quick-shortcut-change')!.getAttribute('aria-label')).toBe(q.changeAria);
    await press('quick-shortcut-change');
    expect(el('quick-shortcut-cancel')!.getAttribute('aria-label')).toBe(q.cancelAria);
    await keydown('Escape');
    expect(document.activeElement).toBe(el('quick-shortcut-change'));
  });
});
