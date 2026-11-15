// @vitest-environment jsdom
//
// story 4909 (UI-R1 AC3, 2d-1) — the group's knowledge moved into the hook `useAgentPermissionRequests()` (read clocks · SSE frames · answers · phone bridge · the «remote control is off» line), so the approvals
// list's next section can read the SAME source. This pins the contract that section relies on: what the hook returns, that the group still draws from it, and that ONE mounted reader means ONE read and ONE
// subscription (a second reader would run the 15 s clock and the SSE frames twice on one screen).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { PermissionRequest } from '@/lib/agent-permissions';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
const { sseSubscriptions, live } = vi.hoisted(() => ({ sseSubscriptions: vi.fn(), live: { n: 0 } }));
// a subscription that counts itself: `live.n` is how many readers are mounted right now (the hook subscribes on mount, unsubscribes on unmount)
vi.mock('@/hooks/use-sse-notifications', async () => {
  const { useEffect } = await import('react');
  return { useSseNotifications: (o: unknown) => { sseSubscriptions(o); useEffect(() => { live.n += 1; return () => { live.n -= 1; }; }, []); } };
});
const { AgentPermissionRequests, PermissionCard, useAgentPermissionRequests } = await import('./agent-permission-requests');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse('2026-10-03T14:00:00Z');
const req = (id: string, over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id, request_id: `q-${id}`, setup_id: 's1', device_name: 'MacBook', agent_member_id: 'a1', agent_name: 'Dev', role: '개발', tool: 'Bash', summary: 'npm install', masked: false, truncated: false, workdir: '~/p',
  created_at: '2026-10-03T13:48:00Z', expires_at: '2026-10-03T14:30:00Z', state: 'pending', answered_by_name: null, decision: null, device_reachable: true, recipient_reason: 'paired', answerable: true,
  session_key: 's-1', input_hash: 'sha256:' + 'a'.repeat(64), ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  fetchWithAuth.mockReset(); sseSubscriptions.mockReset(); live.n = 0;
  fetchWithAuth.mockImplementation(async (url: string) => (url === '/api/agent-permission-requests'
    ? new Response(JSON.stringify({ requests: [req('r1'), req('r2', { agent_name: 'Writer' })] }), { status: 200 })
    : new Response('{}', { status: 404 })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.useRealTimers(); });

const intl = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

/** what the approvals list's section will do: read the hook and draw its rows */
function Probe() {
  const g = useAgentPermissionRequests();
  return (
    <div>
      <span data-testid="ids">{g.shown.map((r) => r.id).join(',')}</span>
      <span data-testid="phone">{String(g.phone)}</span>
      <span data-testid="answer-r1">{String(g.shown[0] ? g.answerFor(g.shown[0]) === null : true)}</span>
      <div data-testid="off-line">{g.offLine}</div>
      {g.shown.map((r) => <PermissionCard key={r.id} request={r} now={g.now} phone={g.phone} auth={g.auth} answer={g.answerFor(r)} onAnswer={(d) => g.onAnswer(r, d)} />)}
    </div>
  );
}

describe('useAgentPermissionRequests (story 4909 · 2d-1)', () => {
  it('⭐one read of the server list, the rows in order, nothing answered yet, not in the phone app — and the exported card draws each row', async () => {
    await act(async () => { root.render(intl(<Probe />)); });
    await settle();
    expect(fetchWithAuth.mock.calls.filter((c) => c[0] === '/api/agent-permission-requests')).toHaveLength(1);
    expect(container.querySelector('[data-testid="ids"]')?.textContent).toBe('r1,r2');
    expect(container.querySelector('[data-testid="phone"]')?.textContent).toBe('false');
    expect(container.querySelector('[data-testid="answer-r1"]')?.textContent).toBe('true');
    expect(container.querySelectorAll('[data-testid="agent-permission-card"]')).toHaveLength(2);
  });

  const reads = () => fetchWithAuth.mock.calls.filter((c) => c[0] === '/api/agent-permission-requests').length;

  it('⭐the group is drawn FROM the hook: the same two requests, the same heading with the count, and the two named SSE frames', async () => {
    await act(async () => { root.render(intl(<AgentPermissionRequests />)); });
    await settle();
    expect(container.textContent).toContain('에이전트 권한 요청 · 2');
    expect(container.querySelectorAll('[data-testid="agent-permission-card"]')).toHaveLength(2);
    const lastOptions = sseSubscriptions.mock.calls.at(-1)![0] as { extraEventNames?: string[] };
    expect(lastOptions.extraEventNames).toEqual(['dispatched', 'agent.permission_request.changed']);
  });

  it('⭐ONE mounted reader = ONE live subscription and ONE 15 s read clock (one read at mount, one more after 15 s — not two clocks)', async () => {
    await act(async () => { root.render(intl(<AgentPermissionRequests />)); });
    await settle();
    expect(live.n).toBe(1); // reverted (the hook subscribing twice) → 2
    expect(reads()).toBe(1);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(reads()).toBe(2);
    await act(async () => { root.render(intl(<div />)); });
    expect(live.n).toBe(0); // unmounting unsubscribes
  });

  it('a SECOND reader on the same screen doubles both — which is why the approvals list\'s section must be the ONLY reader once the old block is taken out (2d-2 pins this on the whole screen)', async () => {
    await act(async () => { root.render(intl(<><AgentPermissionRequests /><Probe /></>)); });
    await settle();
    expect(live.n).toBe(2);
    expect(reads()).toBe(2);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(reads()).toBe(4);
  });

  it('an empty list draws nothing (the group) while the hook still reports an empty `shown` — a section with no rows draws no heading', async () => {
    fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ requests: [] }), { status: 200 }));
    await act(async () => { root.render(intl(<AgentPermissionRequests />)); });
    await settle();
    expect(container.querySelector('[data-testid="agent-permission-requests"]')).toBeNull();
  });
});
