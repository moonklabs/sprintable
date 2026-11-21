// @vitest-environment jsdom
//
// story 4977 (B3-3) — `useRecordsShell`: does this phone shell open records. Asked once per turn-on, only in the phone app; turning it off forgets the answer, and the answer of a read still on its way is not taken.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const bridge = vi.hoisted(() => ({ inPhoneApp: true, phoneCall: vi.fn() }));
vi.mock('@/components/providers/phone-bridge-context', () => ({ usePhoneBridge: () => bridge }));
const { useRecordsShell } = await import('./use-records-shell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let seen: boolean[] = [];
function Probe({ enabled }: { enabled: boolean }) { const v = useRecordsShell(enabled); seen.push(v); return <span data-testid="v">{String(v)}</span>; }
const value = () => container.querySelector('[data-testid="v"]')!.textContent;
const caps = (records: unknown) => bridge.phoneCall.mockImplementation(async (type: string) => (type === 'shell.caps' ? { id: 'c', ok: true, caps: { records } } : { id: 'c', ok: false, code: 'bad_request' }));
const capsCalls = () => bridge.phoneCall.mock.calls.filter((c) => c[0] === 'shell.caps').length;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const render = async (enabled: boolean) => { await act(async () => { root.render(<Probe enabled={enabled} />); }); await settle(); };

beforeEach(() => { bridge.inPhoneApp = true; bridge.phoneCall.mockReset(); seen = []; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('useRecordsShell', () => {
  it('true only in the phone app, for an enabled place, once the shell says `records: 1` — and asked once', async () => {
    caps(1);
    await render(true);
    expect(value()).toBe('true');
    await render(true);
    expect(capsCalls()).toBe(1);
  });

  it('never true (and never asked) in a browser or for a place that has no entry', async () => {
    caps(1);
    bridge.inPhoneApp = false;
    await render(true);
    expect(value()).toBe('false');
    bridge.inPhoneApp = true;
    await render(false);
    expect(value()).toBe('false');
    expect(capsCalls()).toBe(0);
  });

  it('turned off, it forgets: turned on again it is asked again and says false until the shell answers', async () => {
    caps(1);
    await render(true);
    expect(value()).toBe('true');
    await render(false);
    expect(value()).toBe('false');
    let release: (v: unknown) => void = () => {};
    bridge.phoneCall.mockImplementation(() => new Promise((r) => { release = r; }));
    await render(true);
    expect(value()).toBe('false'); // not the old answer
    expect(capsCalls()).toBe(2);
    await act(async () => { release({ id: 'c', ok: true, caps: { records: 1 } }); });
    await settle();
    expect(value()).toBe('true');
  });

  it('the answer of a read turned off meanwhile is not taken', async () => {
    let release: (v: unknown) => void = () => {};
    bridge.phoneCall.mockImplementation(() => new Promise((r) => { release = r; }));
    await render(true);
    await render(false);
    await act(async () => { release({ id: 'c', ok: true, caps: { records: 1 } }); });
    await settle();
    expect(value()).toBe('false');
    expect(seen).not.toContain(true);
  });

  it('an older shell (no `records`, 0, 2, a word) is false', async () => {
    for (const records of [undefined, 0, 2, true, '1']) {
      await act(async () => { root.unmount(); }); root = createRoot(container);
      caps(records);
      await render(true);
      expect(value(), String(records)).toBe('false');
    }
  });
});
