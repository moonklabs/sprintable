// @vitest-environment jsdom
//
// story #4607 (PO 22:48Z): the approvals list reads at once when a new request's notice comes the way the server really sends it —
// a NAMED SSE frame `event: dispatched` (backend routers/events.py backfill · live) — through the REAL useSseNotifications hook, on
// both of its paths: the shared multiplexer (dev/prod) and its own EventSource (no provider). The component test next door mocks
// the hook and calls onNotification directly, a shape the server never sends — green while the real flow read nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { PermissionRequest } from '@/lib/agent-permissions';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

// the multiplexer path: only the context is stood in — the hook itself is real and subscribes by name on it
type Handler = (raw: string) => void;
const mux = { named: new Map<string, Set<Handler>>(), messages: new Set<Handler>(), on: false };
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => (mux.on ? {
    subscribe: (name: string, h: Handler) => { const s = mux.named.get(name) ?? new Set(); s.add(h); mux.named.set(name, s); return () => { s.delete(h); }; },
    subscribeMessage: (h: Handler) => { mux.messages.add(h); return () => { mux.messages.delete(h); }; },
    subscribeReconnect: () => () => {},
    isAlive: () => true,
  } : null),
}));

const { AgentPermissionRequests } = await import('./agent-permission-requests');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the own-EventSource path: a stand-in EventSource that keeps its named listeners
type Listener = (e: { data: string; lastEventId?: string }) => void;
let sources: Array<{ listeners: Record<string, Listener[]>; onmessage: Listener | null }> = [];
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  h = { listeners: {} as Record<string, Listener[]>, onmessage: null as Listener | null };
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { sources.push(this.h); }
  set onmessage(cb: Listener | null) { this.h.onmessage = cb; }
  get onmessage() { return this.h.onmessage; }
  addEventListener(name: string, cb: Listener) { (this.h.listeners[name] ??= []).push(cb); }
  close() {}
}

const NOW = Date.parse('2026-10-03T14:00:00Z');
const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'r1', request_id: 'q1', setup_id: 's1', device_name: 'SYJ-MacBook-Pro', agent_member_id: 'a1', agent_name: 'Dev', role: '개발',
  tool: 'Bash', summary: 'npm install', masked: false, truncated: false, workdir: '~/w',
  created_at: '2026-10-03T13:58:00Z', expires_at: '2026-10-03T14:30:00Z', state: 'pending', answered_by_name: null, decision: null,
  device_reachable: true, recipient_reason: 'paired', answerable: true, session_key: 's-1', input_hash: 'sha256:' + 'a'.repeat(64), ...over,
});
const answer = (requests: PermissionRequest[]) => new Response(JSON.stringify({ requests }), { status: 200 });
// the frame the server writes for a person's notice (routers/events.py `_backfill_frame_data` + the live loop's is_backfill)
const noticeFrame = (eventType: string, id: string) => JSON.stringify({
  event_type: 'dispatched', event_id: id, source: { type: 'agent_permission_request', id: 'r1' }, sender_id: null,
  payload: { title: 'Dev on SYJ-MacBook-Pro', body: 'Bash', event_type: eventType }, title: 'Dev on SYJ-MacBook-Pro', body: 'Bash',
  created_at: '2026-10-03T14:00:00Z', is_backfill: false,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  fetchWithAuth.mockReset();
  sources = [];
  mux.named.clear(); mux.messages.clear(); mux.on = false;
  vi.stubGlobal('EventSource', FakeEventSource);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <AgentPermissionRequests />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const line = () => container.querySelector('[data-testid="agent-permission-line"]')?.textContent;

describe('AgentPermissionRequests · the named `dispatched` frame through the real hook (story #4607)', () => {
  it('own EventSource: a new request\'s `dispatched` frame reads at once · another kind does not · another frame name does not', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([]));
    await render();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const es = sources.at(-1)!;
    const send = async (name: string, data: string) => { await act(async () => { for (const cb of es.listeners[name] ?? []) cb({ data }); }); };
    await send('dispatched', noticeFrame('conversation.message', 'e0'));
    await send('dispatched_x', noticeFrame('agent.permission_request', 'e8')); // a name the server does not write
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await send('dispatched', noticeFrame('agent.permission_request', 'e1'));
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(line()).toBe('짝지은 폰에서 답할 수 있어요');
  });

  it('[4612] own EventSource: a request\'s change frame `agent.permission_request.changed` reads at once (the transient frame\'s shape)', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await render();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const es = sources.at(-1)!;
    fetchWithAuth.mockResolvedValueOnce(answer([]));
    // the live frame of a transient push: its keys + the id the stream gave it (routers/events.py live loop) · no payload, no summary
    const frame = JSON.stringify({ event_type: 'agent.permission_request.changed', request_id: 'q1', state: 'answered', event_id: 't-1', is_backfill: false });
    await act(async () => { for (const cb of es.listeners['agent.permission_request.changed'] ?? []) cb({ data: frame }); });
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="agent-permission-card"]')).toBeNull(); // the card left (answered elsewhere)
  });

  it('shared multiplexer: the hook subscribes `dispatched` by name and a new request\'s frame reads at once', async () => {
    mux.on = true;
    fetchWithAuth.mockResolvedValueOnce(answer([]));
    await render();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(mux.named.get('dispatched')?.size ?? 0).toBeGreaterThan(0);
    await act(async () => { for (const h of mux.named.get('dispatched') ?? []) h(noticeFrame('conversation.message', 'm0')); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await act(async () => { for (const h of mux.named.get('dispatched') ?? []) h(noticeFrame('agent.permission_request', 'm1')); });
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(line()).toBe('짝지은 폰에서 답할 수 있어요');
  });
});
