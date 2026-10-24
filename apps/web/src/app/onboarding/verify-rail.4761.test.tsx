// @vitest-environment jsdom
/**
 * story #4761 (D1 · D1b) — 4759 web-road walk: the agent called its first tool at 23:24:04Z and the server said verified:true,
 * but the connect panel stayed «연결 대기» for 100 s+ while saying «자동으로 다시 시도해요» (the onboarding connect step is outside
 * the RealtimeProvider, so no SSE push ever came — verify-rail.tsx header). A panel that says it retries must retry, and when it
 * is connected it must say what was seen: the first call of this key.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import ko from '../../../messages/ko.json';
import {
  nextPollDelay, parseFirstCallAt, POLL_FAST_MS, POLL_GIVE_UP_MS, POLL_SLOW_AFTER_MS, POLL_SLOW_MS,
  useVerificationRail,
} from './verify-rail';

vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WAITING = { data: { verified: false, rail: [
  { state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'active' },
  { state: 'mcp_reachable', status: 'pending' }, { state: 'verified', status: 'pending' },
] } };
const VERIFIED = (first?: string) => ({ data: { verified: true, first_call_at: first ?? null, rail: [
  { state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'done' },
  { state: 'mcp_reachable', status: 'done' }, { state: 'verified', status: 'done' },
] } });

describe('nextPollDelay — the beat', () => {
  it('fast at first, slower after two minutes, gives up after twenty', () => {
    expect(nextPollDelay(0)).toBe(POLL_FAST_MS);
    expect(nextPollDelay(POLL_SLOW_AFTER_MS - 1)).toBe(POLL_FAST_MS);
    expect(nextPollDelay(POLL_SLOW_AFTER_MS)).toBe(POLL_SLOW_MS);
    expect(nextPollDelay(POLL_GIVE_UP_MS - 1)).toBe(POLL_SLOW_MS);
    expect(nextPollDelay(POLL_GIVE_UP_MS)).toBeNull();
  });
});

describe('parseFirstCallAt', () => {
  it('reads the wrapped answer ({data:{first_call_at}}) and the bare one; anything else is null', () => {
    const iso = '2026-10-23T23:24:04.418874+00:00';
    expect(parseFirstCallAt({ data: { first_call_at: iso } })).toBe(iso);
    expect(parseFirstCallAt({ first_call_at: iso })).toBe(iso);
    expect(parseFirstCallAt({ data: { first_call_at: null } })).toBeNull();
    expect(parseFirstCallAt({ data: { first_call_at: 'not a time' } })).toBeNull();
    expect(parseFirstCallAt({ data: [] })).toBeNull();
    expect(parseFirstCallAt(null)).toBeNull();
    expect(parseFirstCallAt('x')).toBeNull();
  });
});

describe('useVerificationRail — the panel asks again by itself (D1) and says what it saw (D1b)', () => {
  const opts = { agentId: 'a1', transport: 'http' as const, enabled: true, configCopiedDone: true };
  let answer: unknown;
  const calls = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('verification-status')).length;

  function Harness({ o }: { o: Parameters<typeof useVerificationRail>[0] }) {
    const rail = useVerificationRail(o);
    return (
      <div>
        <span data-testid="verified">{String(rail.verified)}</span>
        <span data-testid="first">{String(rail.firstCallAt)}</span>
      </div>
    );
  }
  function mount(o = opts) {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(<NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul"><Harness o={o} /></NextIntlClientProvider>);
    });
    const read = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
    return { read, unmount: () => act(() => root.unmount()) };
  }
  const flush = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  beforeEach(() => {
    vi.useFakeTimers();
    answer = WAITING;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => answer })) as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('D1: while not verified it asks again on the beat — and turns verified by itself the moment the server says so', async () => {
    const { read, unmount } = mount();
    await flush(0);
    const afterMount = calls();
    expect(read('verified')).toBe('false');
    await flush(POLL_FAST_MS);
    expect(calls()).toBe(afterMount + 1);
    await flush(POLL_FAST_MS);
    expect(calls()).toBe(afterMount + 2);
    answer = VERIFIED('2026-10-23T23:24:04.418874+00:00'); // the agent called its first tool
    await flush(POLL_FAST_MS);
    expect(read('verified')).toBe('true'); // no click, no push
    unmount();
  });

  it('it stops asking once verified', async () => {
    const { unmount } = mount();
    answer = VERIFIED();
    await flush(POLL_FAST_MS);
    const settled = calls();
    await flush(60_000);
    expect(calls()).toBe(settled);
    unmount();
  });

  it('D1b: connected → the first call the server saw is handed to the screen; not connected → none', async () => {
    const { read, unmount } = mount();
    await flush(0);
    expect(read('first')).toBe('null');
    answer = VERIFIED('2026-10-23T23:24:04.418874+00:00');
    await flush(POLL_FAST_MS);
    expect(read('first')).toBe('2026-10-23T23:24:04.418874+00:00');
    unmount();
  });

  it('a hidden tab is skipped; showing it again asks at once', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const { unmount } = mount();
    await flush(0);
    const afterMount = calls();
    await flush(POLL_FAST_MS * 3);
    expect(calls()).toBe(afterMount);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush(0);
    expect(calls()).toBe(afterMount + 1);
    unmount();
  });

  it('it gives up after POLL_GIVE_UP_MS (the [다시 테스트] button is what is left)', async () => {
    const { unmount } = mount();
    await flush(POLL_GIVE_UP_MS + POLL_SLOW_MS * 2);
    const settled = calls();
    await flush(5 * 60_000);
    expect(calls()).toBe(settled);
    unmount();
  });

  it('not enabled → it never asks', async () => {
    const { unmount } = mount({ ...opts, enabled: false });
    await flush(POLL_FAST_MS * 5);
    expect(calls()).toBe(0);
    unmount();
  });
});
