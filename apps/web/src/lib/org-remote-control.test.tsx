// @vitest-environment jsdom
//
// story #4535 (까디르 4944 프로브 · PO 19:06Z) — the one value of the org's «원격 제어»: a read's answer never covers a change made
// after the read began (① a late «off» after [켬] put the switch back off), and a StrictMode remount reads once (②).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
const { useOrgRemoteControl, connectedSetupsOf } = await import('./org-remote-control');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = (enabled: boolean) => ({ enabled, enabled_at: null, can_change: true });
const answer = (enabled: boolean) => new Response(JSON.stringify({ data: state(enabled) }), { status: 200 });

let seen: { enabled: boolean } | null = null;
let setIt: ((next: ReturnType<typeof state>) => void) | null = null;
const report = (value: { enabled: boolean } | null, set: (next: ReturnType<typeof state>) => void) => { seen = value; setIt = set; };
function Probe({ onValue = report }: { onValue?: typeof report }) {
  const [value, set] = useOrgRemoteControl('org-1');
  onValue(value, set);
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fetchWithAuth.mockReset(); seen = null; setIt = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

describe('useOrgRemoteControl', () => {
  it('① a read begun before [켬] does not put the value back to off when it lands late', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer(false));
    await act(async () => { root.render(<Probe />); });
    await flush();
    expect(seen?.enabled).toBe(false);
    // leave the page, come back: a new read goes out and stays out
    await act(async () => { root.render(<></>); });
    let land!: (r: Response) => void;
    fetchWithAuth.mockImplementationOnce(() => new Promise<Response>((r) => { land = r; }));
    await act(async () => { root.render(<Probe />); });
    // the switch's own answer arrives first (the PUT succeeded)
    await act(async () => { setIt!(state(true)); });
    expect(seen?.enabled).toBe(true);
    // then the old read lands with «off»
    await act(async () => { land(answer(false)); });
    await flush();
    expect(seen?.enabled).toBe(true);
  });

  it('② a StrictMode remount reads once', async () => {
    fetchWithAuth.mockResolvedValue(answer(true));
    await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); });
    await flush();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(seen?.enabled).toBe(true);
  });
});

// story 4584 (PO review): either deploy order is safe — a web that reads the new name shows the line when only the old one arrives
describe('[4584] the live-setups count, old name kept for one deploy', () => {
  const base = { enabled: false, enabled_at: null, can_change: false };

  it('reads the new name', () => {
    expect(connectedSetupsOf({ ...base, connected_setups: 2 })).toBe(2);
  });

  it('a response with only the old name still counts (the web ahead of the backend)', () => {
    expect(connectedSetupsOf({ ...base, connected_computers: 1 })).toBe(1);
  });

  it('neither name counts as none', () => {
    expect(connectedSetupsOf(base)).toBe(0);
  });
});
