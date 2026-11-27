// @vitest-environment jsdom
/**
 * story 5047 (C14 · PO 11-27) — the quick-ask window's page, drawn from a fake of the app's bridge. The page draws the state it is given and reports what the person did; the app decides when the window closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { QuickViewState } from '@/lib/quick/quick-view';

const loadQuickTargets = vi.fn();
const quickSend = vi.fn();
vi.mock('@/lib/quick/quick-api', () => ({ loadQuickTargets: (...a: unknown[]) => loadQuickTargets(...a), quickSend: (...a: unknown[]) => quickSend(...a) }));

import { QuickAsk } from './quick-ask';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const q = koMessages.quick;

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const BASE: QuickViewState = { open: true, phase: 'empty', text: '', target: null, pickQuery: '', attach: { kind: 'off' }, failure: null };
const TARGETS = [{ kind: 'channel' as const, id: 'ch1', name: '첫 프로젝트' }, { kind: 'agent' as const, id: 'a1', name: 'Dan' }, { kind: 'agent' as const, id: 'a2', name: 'Mirko' }];

let container: HTMLDivElement;
let root: Root;
let events: Record<string, unknown>[];
let stateFn: ((s: unknown) => void) | null;
let postFn: ((p: unknown) => void) | null;
let resized: number[];
let readyCalls: number;

const flush = async () => { for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); }); };
const push = async (s: Partial<QuickViewState>) => { await act(async () => { stateFn?.({ ...BASE, ...s }); }); await flush(); };
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const input = () => byId('quick-input') as HTMLInputElement;
const types = () => events.map((e) => e.type);

function setValue(el: HTMLInputElement, v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

async function mount(withBridge = true) {
  if (withBridge) {
    (window as unknown as { quickAsk?: unknown }).quickAsk = {
      onState: (fn: (s: unknown) => void) => { stateFn = fn; return () => { stateFn = null; }; },
      onPost: (fn: (p: unknown) => void) => { postFn = fn; return () => { postFn = null; }; },
      event: async (e: Record<string, unknown>) => { events.push(e); },
      resize: (h: number) => { resized.push(h); },
      ready: () => { readyCalls += 1; },
    };
  }
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><QuickAsk /></NextIntlClientProvider>); });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  events = []; stateFn = null; postFn = null; resized = []; readyCalls = 0;
  loadQuickTargets.mockReset().mockResolvedValue({ ok: true, projectId: 'p1', targets: TARGETS });
  quickSend.mockReset().mockResolvedValue(201);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
});
afterEach(() => { act(() => root.unmount()); container.remove(); delete (window as unknown as { quickAsk?: unknown }).quickAsk; });

describe('[SID:5047] the page', () => {
  it('without the app\'s bridge (an ordinary browser tab) it says it opens only in the app', async () => {
    await mount(false);
    expect(byId('quick-no-bridge')?.textContent).toBe(q.onlyInApp);
  });

  it('it tells the app it is ready, and draws nothing while the window is closed', async () => {
    await mount();
    expect(readyCalls).toBe(1);
    await push({ open: false });
    expect(byId('quick-input')).toBeNull();
  });

  it('open and empty: the input, the hint for «no place yet» and the check «지금 창 함께 보내기» (off)', async () => {
    await mount();
    await push({});
    expect(input().placeholder).toBe(q.placeholder);
    expect(byId('quick-hint')?.textContent).toBe(q.hintNoTarget);
    expect(byId('quick-attach')?.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(q.attachLabel);
  });

  it('the places are read when the window opens (and again for the next opening)', async () => {
    await mount();
    await push({});
    expect(loadQuickTargets).toHaveBeenCalledTimes(1);
    await push({ open: false });
    await push({});
    expect(loadQuickTargets).toHaveBeenCalledTimes(2);
  });

  it('it reports the height it needs to the app', async () => {
    await mount();
    await push({});
    expect(resized.length).toBeGreaterThan(0);
  });

  it('a state it cannot read is dropped (the page keeps what it last drew)', async () => {
    await mount();
    await push({ text: 'abc' });
    await act(async () => { stateFn?.({ open: 'maybe' }); });
    expect(input().value).toBe('abc');
  });
});

describe('[SID:5047] typing, picking and sending are reported — never decided here', () => {
  it('typing reports the words', async () => {
    await mount();
    await push({});
    await act(async () => { setValue(input(), '오늘 일'); });
    expect(events.at(-1)).toEqual({ type: 'text', value: '오늘 일' });
  });

  it('«@» at the start of a word opens the list: the words (without the «@») and then «pick-start»', async () => {
    await mount();
    await push({ text: '정리해 줘 ' });
    await act(async () => { setValue(input(), '정리해 줘 @'); });
    expect(events).toEqual([{ type: 'text', value: '정리해 줘 ' }, { type: 'pick-start' }]);
  });

  it('an «@» inside a word (an e-mail address) is just a letter', async () => {
    await mount();
    await push({ text: 'a' });
    await act(async () => { setValue(input(), 'a@'); });
    expect(events).toEqual([{ type: 'text', value: 'a@' }]);
  });

  it('while picking: the list shows the places, the query filters, Enter picks the one under the cursor, the arrows move it', async () => {
    await mount();
    await push({ phase: 'picking' });
    const items = () => [...container.querySelectorAll('[role="option"]')].map((x) => x.textContent);
    expect(items()).toEqual([`첫 프로젝트${q.kindChannel}`, `Dan${q.kindAgent}`, `Mirko${q.kindAgent}`]);
    key(input(), 'ArrowDown');
    await flush();
    key(input(), 'Enter');
    expect(events.at(-1)).toEqual({ type: 'pick', target: TARGETS[1] });

    await push({ phase: 'picking', pickQuery: 'mir' });
    expect(items()).toEqual([`Mirko${q.kindAgent}`]);
    key(input(), 'Enter');
    expect(events.at(-1)).toEqual({ type: 'pick', target: TARGETS[2] });
  });

  it('a click on a place picks it (the input keeps its focus)', async () => {
    await mount();
    await push({ phase: 'picking' });
    const opt = container.querySelectorAll('[role="option"]')[1] as HTMLElement;
    await act(async () => { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
    expect(events.at(-1)).toEqual({ type: 'pick', target: TARGETS[1] });
  });

  it('while picking, typing is the query, and deleting the «@» leaves the list (Esc\'s own step)', async () => {
    await mount();
    await push({ phase: 'picking', pickQuery: 'd' });
    expect(input().value).toBe('@d');
    await act(async () => { setValue(input(), '@da'); });
    expect(events.at(-1)).toEqual({ type: 'pick-query', value: 'da' });
    await act(async () => { setValue(input(), ''); });
    expect(events.at(-1)).toEqual({ type: 'escape' });
  });

  it('with no place that matches, or places that could not be read, it says so (never an empty box)', async () => {
    await mount();
    await push({ phase: 'picking', pickQuery: 'zzz' });
    expect(container.textContent).toContain(q.noMatch);
    loadQuickTargets.mockResolvedValue({ ok: false, reason: 'failed' });
    await push({ open: false });
    await push({ phase: 'picking' });
    expect(container.textContent).toContain(q.loadFailed);
  });

  it('the chosen place is the chip before the words, and the hint no longer asks for a place', async () => {
    await mount();
    await push({ target: TARGETS[1]!, text: 'hi' });
    expect(byId('quick-chip')?.textContent).toBe('@Dan');
    expect(byId('quick-hint')?.textContent).toBe(q.hintReady);
  });

  it('Enter sends (reported), Esc reports escape, and Enter during a Korean syllable still being composed is NOT a send', async () => {
    await mount();
    await push({ text: 'hi', target: TARGETS[1]! });
    key(input(), 'Enter', { isComposing: true } as KeyboardEventInit);
    expect(types()).toEqual([]);
    key(input(), 'Enter');
    expect(types()).toEqual(['send']);
    key(input(), 'Escape');
    expect(types()).toEqual(['send', 'escape']);
  });

  it('while sending, the input is locked and says so', async () => {
    await mount();
    await push({ phase: 'sending', text: 'hi', target: TARGETS[1]! });
    expect(input().disabled).toBe(true);
    expect(byId('quick-sending')?.textContent).toBe(q.sending);
  });
});

describe('[SID:5047] the app asks, the page sends, the answer\'s status goes back', () => {
  const post = { text: '안녕', target: TARGETS[1]!, picture: null };

  it('a request is made through quickSend and the status that comes back is reported as it is (reverted → a number is turned into ok / not ok)', async () => {
    await mount();
    await push({});
    for (const status of [201, 401, 500, null]) {
      quickSend.mockResolvedValueOnce(status);
      await act(async () => { postFn?.(post); });
      await flush();
      expect(events.at(-1)).toEqual({ type: 'send-result', status });
    }
    expect(quickSend).toHaveBeenCalledWith(post, 'p1');
  });

  it('a send right after the window was opened again — before the places are read — does not carry the LAST opening\'s project (the person may have switched projects): it asks for none, and the sender reads the current one (codex)', async () => {
    await mount();
    await push({});
    await push({ open: false });
    loadQuickTargets.mockReturnValue(new Promise(() => undefined)); // the second opening's read never lands
    await push({});
    await act(async () => { postFn?.(post); });
    await flush();
    expect(quickSend).toHaveBeenLastCalledWith(post, null); // reverted (the old project is kept) → 'p1'
  });

  it('a request that cannot be read is answered at once as a refusal — never left for the app to wait out', async () => {
    await mount();
    await push({});
    await act(async () => { postFn?.({ text: 5 }); });
    expect(events.at(-1)).toEqual({ type: 'send-result', status: 422 });
    expect(quickSend).not.toHaveBeenCalled();
  });
});

describe('[SID:5047] a failure stays on the screen, in words, with the way to try again', () => {
  it.each([['rejected', q.failure.rejected], ['server', q.failure.server], ['offline', q.failure.offline]] as const)('%s: the line, and «다시 보내기» reports a send', async (failure, line) => {
    await mount();
    await push({ phase: 'failed', failure, text: 'hi', target: TARGETS[1]! });
    expect(byId('quick-failure')?.textContent).toContain(line);
    (byId('quick-failure')!.querySelector('button') as HTMLButtonElement).click();
    expect(events.at(-1)).toEqual({ type: 'send' });
  });

  it('the offline line does not promise the line was not sent (a retry could send it twice)', () => {
    expect(q.failure.offline).toContain('확인');
  });

  it('after «offline» (no answer — it may have gone through) neither Enter nor a plain button sends it again: the button says «그래도 다시 보내기», Enter does nothing; any other failure sends on Enter (codex: a blind retry could send the line twice)', async () => {
    await mount();
    await push({ phase: 'failed', failure: 'offline', text: 'hi', target: TARGETS[1]! });
    expect(byId('quick-failure')!.querySelector('button')!.textContent).toBe(q.retryAnyway);
    key(input(), 'Enter');
    expect(events).toEqual([]);
    (byId('quick-failure')!.querySelector('button') as HTMLButtonElement).click();
    expect(events.at(-1)).toEqual({ type: 'send' }); // a choice, not a slip
    events.length = 0;
    await push({ phase: 'failed', failure: 'server', text: 'hi', target: TARGETS[1]! });
    expect(byId('quick-failure')!.querySelector('button')!.textContent).toBe(q.retry);
    key(input(), 'Enter');
    expect(events).toEqual([{ type: 'send' }]);
  });

  it('401: «로그인이 필요해요» and «앱 열기» reports open-main; the words are still in the input', async () => {
    await mount();
    await push({ phase: 'login', failure: 'login', text: 'hi', target: TARGETS[1]! });
    expect(byId('quick-login')?.textContent).toContain(q.loginNeeded);
    expect(input().value).toBe('hi');
    (byId('quick-login')!.querySelector('button') as HTMLButtonElement).click();
    expect(events.at(-1)).toEqual({ type: 'open-main' });
  });

  it('«@» typed before the signed-out answer lands: the picker says so and offers the app (not an empty list) — codex', async () => {
    loadQuickTargets.mockResolvedValue({ ok: false, reason: 'login' });
    await mount();
    await push({ phase: 'picking' });
    expect(byId('quick-login')?.textContent).toContain(q.loginNeeded);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    (byId('quick-login')!.querySelector('button') as HTMLButtonElement).click();
    expect(events.at(-1)).toEqual({ type: 'open-main' });
  });

  it('the picker\'s own messages (loading · could not be read · nothing matches) are status lines OUTSIDE the listbox — the listbox holds options only (codex)', async () => {
    loadQuickTargets.mockResolvedValue({ ok: false, reason: 'failed' });
    await mount();
    await push({ phase: 'picking' });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(q.loadFailed);
  });

  it('a signed-out person is told when the places cannot be read for that reason', async () => {
    loadQuickTargets.mockResolvedValue({ ok: false, reason: 'login' });
    await mount();
    await push({});
    expect(byId('quick-login')?.textContent).toContain(q.loginNeeded);
  });

  it('the question before words that did not go are thrown away', async () => {
    await mount();
    await push({ phase: 'discard', failure: 'server', text: 'hi', target: TARGETS[1]! });
    expect(byId('quick-discard')?.textContent).toBe(q.discard);
  });
});

describe('[SID:5047] 지금 창 함께 보내기', () => {
  it('the check reports a toggle (the app reads the permission, not the page)', async () => {
    await mount();
    await push({});
    (byId('quick-attach') as HTMLElement).click();
    expect(events.at(-1)).toEqual({ type: 'attach-toggle' });
  });

  it('without the permission: the line and «설정 열기», which reports open-screen-settings', async () => {
    await mount();
    await push({ attach: { kind: 'denied', permission: 'denied' } });
    expect(byId('quick-denied')?.textContent).toContain(q.attachDenied);
    (byId('quick-denied')!.querySelector('button') as HTMLButtonElement).click();
    expect(events.at(-1)).toEqual({ type: 'open-screen-settings' });
    expect(byId('quick-attach')?.getAttribute('aria-checked')).toBe('false');
  });

  it('while capturing it says so and the check is on; when ready: ONE small preview with its name and «빼기»', async () => {
    await mount();
    await push({ attach: { kind: 'capturing' } });
    expect(byId('quick-capturing')?.textContent).toBe(q.capturing);
    expect(byId('quick-attach')?.getAttribute('aria-checked')).toBe('true');
    await push({ attach: { kind: 'ready', preview: { dataUrl: PNG, label: '창 · 터미널 — 민 레 세션' } } });
    const prev = byId('quick-preview')!;
    expect(prev.querySelectorAll('img').length).toBe(1);
    expect((prev.querySelector('img') as HTMLImageElement).src).toBe(PNG);
    expect(prev.textContent).toContain('창 · 터미널 — 민 레 세션');
    (prev.querySelector('button') as HTMLButtonElement).click();
    expect(events.at(-1)).toEqual({ type: 'attach-remove' });
  });
});
