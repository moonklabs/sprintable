// @vitest-environment jsdom
// story 4971 ③ — the web's reading of the app's offered update: a closed shape, the load-time value then pushes, one shared subscription, and a press that takes nothing from the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDesktopAppForTest, appUpdate, appUpdateOfferOf, desktopAppOf, pressAppUpdate, subscribeAppUpdate } from '@/lib/desktop-app';

const base = (extra: Record<string, unknown> = {}) => Object.freeze({
  inApp: true as const, device: Object.freeze({ name: 'mac' }), runtimes: Object.freeze([]),
  pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }), ...extra,
});
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };
beforeEach(() => { __resetDesktopAppForTest(); setBridge(undefined); });
afterEach(() => { setBridge(undefined); __resetDesktopAppForTest(); });

describe('[SID:4971 ③] appUpdateOfferOf — the closed shape', () => {
  it('a canonical N.N.N and one of four phases pass (extra keys are dropped); everything else is no offer', () => {
    expect(appUpdateOfferOf({ version: '0.2.150', phase: 'available', url: 'https://evil.example/x.zip' })).toEqual({ version: '0.2.150', phase: 'available' });
    for (const phase of ['available', 'downloading', 'installing', 'failed']) expect(appUpdateOfferOf({ version: '1.0.0', phase })?.phase).toBe(phase);
    for (const bad of [null, undefined, 'x', 7, [], {}, { version: '0.2.150' }, { phase: 'available' }, { version: '0.2.150-beta', phase: 'available' }, { version: '0.2', phase: 'available' }, { version: 150, phase: 'available' }, { version: '0.2.150', phase: 'oops' }, { version: '01.2.3', phase: 'available' }]) {
      expect(appUpdateOfferOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('[SID:4971 ③] desktopAppOf — the update hands are optional, but present means a function', () => {
  it('an app without them (older) is still the bridge; a non-function startUpdate / subscribeUpdate is not', () => {
    expect(desktopAppOf(base())).toBeDefined();
    expect(desktopAppOf(base({ startUpdate: async () => ({ ok: true }), subscribeUpdate: () => () => undefined }))).toBeDefined();
    expect(desktopAppOf(base({ startUpdate: 'x' }))).toBeUndefined();
    expect(desktopAppOf(base({ subscribeUpdate: {} }))).toBeUndefined();
  });
});

describe('[SID:4971 ③] appUpdate · subscribeAppUpdate', () => {
  it('a browser (no bridge) · an app with nothing on offer → null', () => {
    expect(appUpdate()).toBeNull();
    setBridge(base());
    expect(appUpdate()).toBeNull();
  });
  it('the offer the page loaded with is read (closed shape), the same object each time; a malformed one is null', () => {
    setBridge(base({ update: { version: '0.2.150', phase: 'available' } }));
    const a = appUpdate();
    expect(a).toEqual({ version: '0.2.150', phase: 'available' });
    expect(appUpdate()).toBe(a);
    __resetDesktopAppForTest();
    setBridge(base({ update: { version: 'latest', phase: 'available' } }));
    expect(appUpdate()).toBeNull();
  });
  it('subscribe: the app\'s pushes change the offer and tell every listener once per change — junk is ignored, null clears, one subscription to the app is shared', () => {
    let push: (o: unknown) => void = () => undefined;
    const subscribeUpdate = vi.fn((l: (o: never) => void) => { push = l as (o: unknown) => void; l(null as never); return vi.fn(); });
    setBridge(base({ subscribeUpdate }));
    const a = vi.fn(); const b = vi.fn();
    const stopA = subscribeAppUpdate(a); const stopB = subscribeAppUpdate(b);
    expect(subscribeUpdate).toHaveBeenCalledTimes(1);
    push({ version: '0.2.150', phase: 'available' });
    expect(appUpdate()).toEqual({ version: '0.2.150', phase: 'available' });
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
    push({ version: '0.2.150', phase: 'available' }); // same → not told again
    push({ version: 'nope', phase: 'available' });   // off the closed shape → ignored
    push('junk');
    expect(a).toHaveBeenCalledTimes(1);
    expect(appUpdate()).toEqual({ version: '0.2.150', phase: 'available' });
    push({ version: '0.2.150', phase: 'downloading' });
    expect(appUpdate()?.phase).toBe('downloading');
    push(null);
    expect(appUpdate()).toBeNull();
    expect(a).toHaveBeenCalledTimes(3);
    stopA();
    const stopApp = subscribeUpdate.mock.results[0]!.value as ReturnType<typeof vi.fn>;
    expect(stopApp).not.toHaveBeenCalled();
    stopB();
    expect(stopApp).toHaveBeenCalledTimes(1); // the last listener out releases the app subscription
  });
  it('an app without subscribeUpdate: a no-op subscription, the load-time value stands', () => {
    setBridge(base({ update: { version: '0.2.150', phase: 'available' } }));
    const stop = subscribeAppUpdate(() => undefined);
    expect(typeof stop).toBe('function');
    expect(appUpdate()).toEqual({ version: '0.2.150', phase: 'available' });
  });
});

describe('[SID:4971 ③] pressAppUpdate — takes nothing from the page', () => {
  it('calls the app\'s startUpdate with NO argument and maps the answer; an older app is «unsupported»; a throw is «failed» — never a rejection', async () => {
    const startUpdate = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }));
    setBridge(base({ startUpdate }));
    expect(await pressAppUpdate()).toBe('ok');
    expect(startUpdate).toHaveBeenCalledWith();
    expect(startUpdate.mock.calls[0]).toHaveLength(0);
    for (const code of ['busy', 'failed']) { setBridge(base({ startUpdate: async () => ({ ok: false as const, code }) })); expect(await pressAppUpdate()).toBe(code); }
    setBridge(base({ startUpdate: async () => ({ ok: false as const, code: 'anything' }) }));
    expect(await pressAppUpdate()).toBe('none');
    setBridge(base({ startUpdate: async () => { throw new Error('ipc gone'); } }));
    expect(await pressAppUpdate()).toBe('failed');
    setBridge(base());
    expect(await pressAppUpdate()).toBe('unsupported');
    setBridge(undefined);
    expect(await pressAppUpdate()).toBe('unsupported');
  });
  it('codex: the press goes to the bridge the screen was drawn from when one is given (not to another instance on the page)', async () => {
    const mine = vi.fn(async () => ({ ok: true as const }));
    const other = vi.fn(async () => ({ ok: true as const }));
    setBridge(base({ startUpdate: other }));
    expect(await pressAppUpdate(base({ startUpdate: mine }) as never)).toBe('ok');
    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
