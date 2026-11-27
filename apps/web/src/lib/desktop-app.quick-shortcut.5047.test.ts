import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDesktopAppForTest, desktopAppOf, quickShortcutNow, quickShortcutOf, writeQuickShortcut, type SprintableDesktop } from './desktop-app';

const VIEW = { accelerator: 'Alt+Space', label: '⌥Space', status: 'registered' } as const;
const base = { inApp: true as const, device: Object.freeze({ name: 'Mac' }), runtimes: Object.freeze([]), pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }) };
const bridge = (over: Record<string, unknown> = {}) => Object.freeze({ ...base, quickAskShortcut: VIEW, setQuickAskShortcut: vi.fn(async () => ({ ok: true as const, shortcut: VIEW })), ...over }) as unknown as SprintableDesktop;
beforeEach(() => { __resetDesktopAppForTest(); });
afterEach(() => { __resetDesktopAppForTest(); });

describe('[SID:5047] the shortcut as the app tells it — only the fixed shape', () => {
  it('a view in the shape is taken (a fresh frozen copy)', () => {
    const v = quickShortcutOf(VIEW);
    expect(v).toEqual(VIEW);
    expect(Object.isFrozen(v)).toBe(true);
  });

  it.each([
    ['not an object', 'Alt+Space'], ['null', null], ['an array', []],
    ['no label', { accelerator: 'Alt+Space', status: 'registered' }],
    ['an unknown status', { ...VIEW, status: 'happy' }],
    ['an empty accelerator', { ...VIEW, accelerator: '' }],
    ['a label of the wrong type', { ...VIEW, label: 5 }],
    ['an over-long accelerator', { ...VIEW, accelerator: 'A'.repeat(65) }],
    ['an over-long label', { ...VIEW, label: 'x'.repeat(33) }],
  ])('%s → none', (_n, raw) => {
    expect(quickShortcutOf(raw)).toBeNull();
  });

  it('the page may offer the row only when the app gives the value AND the write hand (an older app · a test build: none)', () => {
    expect(quickShortcutNow(bridge())).toEqual(VIEW);
    expect(quickShortcutNow(bridge({ setQuickAskShortcut: undefined }))).toBeNull();
    expect(quickShortcutNow(bridge({ quickAskShortcut: undefined }))).toBeNull();
    expect(quickShortcutNow(bridge({ quickAskShortcut: { ...VIEW, status: 'x' } }))).toBeNull();
    expect(quickShortcutNow(undefined)).toBeNull();
  });

  it('a write hand that is not a function refuses the whole bridge (the same rule as the other optional hands)', () => {
    expect(desktopAppOf({ ...base, setQuickAskShortcut: 'nope' })).toBeUndefined();
    expect(desktopAppOf({ ...base, setQuickAskShortcut: async () => ({ ok: true }) })).toBeDefined();
  });
});

describe('[SID:5047] writing the shortcut: the answer is what the app KEPT', () => {
  it('ok → the shortcut as kept', async () => {
    const kept = { accelerator: 'Alt+K', label: '⌥K', status: 'registered' };
    expect(await writeQuickShortcut('Alt+K', bridge({ setQuickAskShortcut: async () => ({ ok: true, shortcut: kept }) }))).toEqual({ kind: 'ok', shortcut: kept });
  });

  it('a refusal keeps its code (invalid · conflict) and the old shortcut the app says it kept; any other code is «failed»', async () => {
    const answer = (code: string) => bridge({ setQuickAskShortcut: async () => ({ ok: false, code, shortcut: VIEW }) });
    expect(await writeQuickShortcut('x', answer('invalid'))).toEqual({ kind: 'refused', code: 'invalid', shortcut: VIEW });
    expect(await writeQuickShortcut('x', answer('conflict'))).toEqual({ kind: 'refused', code: 'conflict', shortcut: VIEW });
    expect(await writeQuickShortcut('x', answer('write_failed'))).toEqual({ kind: 'refused', code: 'failed', shortcut: VIEW });
    expect(await writeQuickShortcut('x', answer('bad_request'))).toEqual({ kind: 'refused', code: 'failed', shortcut: VIEW });
  });

  it('nothing usable (a throw · an answer in no shape · an ok with no shortcut) → error — the page never shows what it merely asked for', async () => {
    expect(await writeQuickShortcut('x', bridge({ setQuickAskShortcut: async () => { throw new Error('gone'); } }))).toEqual({ kind: 'error' });
    expect(await writeQuickShortcut('x', bridge({ setQuickAskShortcut: async () => 7 }))).toEqual({ kind: 'error' });
    expect(await writeQuickShortcut('x', bridge({ setQuickAskShortcut: async () => ({ ok: true }) }))).toEqual({ kind: 'error' });
    expect(await writeQuickShortcut('x', bridge({ setQuickAskShortcut: async () => ({ nothing: 1 }) }))).toEqual({ kind: 'error' });
    expect(await writeQuickShortcut('x', undefined)).toEqual({ kind: 'error' });
  });

  it('the text is handed to the app as it is (the page does not judge it)', async () => {
    const b = bridge();
    await writeQuickShortcut('Command+Shift+K', b);
    expect((b.setQuickAskShortcut as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['Command+Shift+K']);
  });
});
