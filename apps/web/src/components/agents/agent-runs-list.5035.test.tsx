// @vitest-environment jsdom
//
// story 5035 (C5) — the agent detail's «실행 기록» cell is the SAME list narrowed to one agent: `agentId` rides on every call as `agent_id` (the server already takes it);
// without it the call has no `agent_id` at all (the «전체 보기 › 실행 기록» screen reads every agent, as before). Reverting either side turns this red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

import { AgentRunsList } from './agent-runs-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: URL[];

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ projectId: 'proj-1' });
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input), 'http://test'));
    return { ok: true, status: 200, json: async () => ({ data: [], meta: null }) } as Response;
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider>{node}</TopBarProvider></NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('AgentRunsList — agentId (story 5035)', () => {
  it('⭐agentId를 주면 모든 호출이 agent_id를 싣는다', async () => {
    await mount(<AgentRunsList agentId="agent-42" />);
    const runCalls = calls.filter((u) => u.pathname === '/api/v1/agent-runs');
    expect(runCalls.length).toBeGreaterThan(0);
    for (const u of runCalls) expect(u.searchParams.get('agent_id')).toBe('agent-42');
  });

  it('agentId가 없으면 agent_id를 싣지 않는다(전체 보기 › 실행 기록은 모든 에이전트)', async () => {
    await mount(<AgentRunsList />);
    const runCalls = calls.filter((u) => u.pathname === '/api/v1/agent-runs');
    expect(runCalls.length).toBeGreaterThan(0);
    for (const u of runCalls) expect(u.searchParams.has('agent_id')).toBe(false);
  });
});
