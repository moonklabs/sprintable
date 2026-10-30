// @vitest-environment jsdom
// story #4833 — the Today list's read: rows after the first answer, again every 30 s, a failed read keeps the rows and moves the clock on, a bad answer is no crash
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => undefined }));

import { useAgentStates } from './use-agent-states';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let last: ReturnType<typeof useAgentStates>;
function Probe() { last = useAgentStates(); return null; }

const ok = (rows: unknown) => ({ ok: true, json: async () => ({ data: rows, meta: { totalCount: null } }) });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T03:00:00Z'));
  h.fetchWithAuth.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.useRealTimers(); });

async function mount() { await act(async () => { root.render(<Probe />); }); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe('useAgentStates', () => {
  it('not loaded until the first answer; then the rows; asks the one list URL', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(ok([{ agent_id: 'a', agent_name: 'A' }]));
    await mount();
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/api/agents/desktop-sessions');
    expect(last.loaded).toBe(true);
    expect(last.rows.map((r) => r.agent_id)).toEqual(['a']);
  });

  it('reads again every 30 s', async () => {
    h.fetchWithAuth.mockResolvedValue(ok([]));
    await mount();
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a failed read keeps the rows and moves the clock on (a limit\'s «passed» is judged on this page\'s time)', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(ok([{ agent_id: 'a', agent_name: 'A' }])).mockRejectedValue(new Error('offline'));
    await mount();
    const first = last.readAt;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(last.rows.map((r) => r.agent_id)).toEqual(['a']);
    expect(last.readAt).toBeGreaterThan(first);
  });

  it('a first read that fails stays «not loaded» (no «0명» claim from a failure); a non-list answer is an empty list, not a crash', async () => {
    h.fetchWithAuth.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await mount();
    expect(last.loaded).toBe(false);
    h.fetchWithAuth.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { unexpected: true } }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(last.loaded).toBe(true);
    expect(last.rows).toEqual([]);
  });
});
