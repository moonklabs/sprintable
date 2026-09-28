// @vitest-environment jsdom
//
// story #4185(E-MOBILE-SPEED) — 에이전트 성과 패널(/organization/workforce?tab=stats)이 에이전트마다
// /api/analytics/agent-stats를 따로 부르던 N+1(prod 한 화면 5회+·각 0.5초) → 묶음 1회.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'proj-1' }) }));
const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));

import { AgentPerformancePanel } from './agent-performance-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); fetchWithAuthMock.mockReset(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const AGENTS = Array.from({ length: 5 }, (_, i) => ({ id: `ag-${i}`, name: `에이전트${i}`, type: 'agent' }));
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });

it('에이전트 5명 — agent-stats는 묶음 1회(단건 0회), 각 에이전트 지표가 그 결과로 뜬다', async () => {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/team-members')) return ok(AGENTS);
    if (url.startsWith('/api/analytics/velocity-history')) return ok([]);
    if (url.startsWith('/api/rewards/leaderboard')) return ok([]);
    if (url.startsWith('/api/analytics/agent-stats/batch')) {
      // ag-4는 일부러 빠짐(프로젝트 밖 판정 등) → 그 에이전트만 빈 지표.
      return ok(Object.fromEntries(AGENTS.slice(0, 4).map((a, i) => [a.id, { completed: 10 + i, total_stories: 20 + i, done_story_points: 0, avg_lead_time_ms: 0 }])));
    }
    return { ok: false, json: async () => ({}) };
  });
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentPerformancePanel /></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

  const urls = fetchWithAuthMock.mock.calls.map(([u]) => String(u));
  const batch = urls.filter((u) => u.startsWith('/api/analytics/agent-stats/batch'));
  expect(batch).toHaveLength(1);
  expect(batch[0]).toContain('project_id=proj-1');
  expect(batch[0]).toContain(`agent_ids=${AGENTS.map((a) => a.id).join(',')}`);
  expect(urls.filter((u) => u.startsWith('/api/analytics/agent-stats?'))).toHaveLength(0);
  expect(container.textContent).toContain('13'); // ag-3 completed
  expect(container.textContent).toContain('23'); // ag-3 total_stories
});

it('에이전트 0명이면 agent-stats를 아예 안 부른다', async () => {
  fetchWithAuthMock.mockImplementation(async (url: string) => (
    url.startsWith('/api/team-members') || url.startsWith('/api/analytics/velocity-history') || url.startsWith('/api/rewards/leaderboard')
      ? ok([]) : { ok: false, json: async () => ({}) }
  ));
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentPerformancePanel /></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  expect(fetchWithAuthMock.mock.calls.some(([u]) => String(u).includes('agent-stats'))).toBe(false);
});

// 유나 design(PR #4560) — 묶음 호출 실패와 «실적 없음(0)»을 갈라 보인다.
function mockWith(batch: 'fail' | Record<string, unknown>) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/team-members')) return ok(AGENTS.slice(0, 2));
    if (url.startsWith('/api/analytics/velocity-history')) return ok([]);
    if (url.startsWith('/api/rewards/leaderboard')) return ok([]);
    if (url.startsWith('/api/analytics/agent-stats/batch')) return batch === 'fail' ? { ok: false, status: 500, json: async () => ({}) } : ok(batch);
    return { ok: false, json: async () => ({}) };
  });
}

async function renderPanel() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentPerformancePanel /></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

it('묶음 500 → 숫자 칸은 «—»(«0» 없음)·안내 한 줄·다시 시도 누르면 묶음 재호출', async () => {
  mockWith('fail');
  await renderPanel();
  const notice = container.querySelector('[data-testid="agent-stats-load-error"]');
  expect(notice?.textContent).toContain(koMessages.agentPerformance.agentStatsLoadError);
  const cells = [...container.querySelectorAll('span.tabular-nums')].map((e) => e.textContent);
  expect(cells.length).toBeGreaterThan(0);
  expect(cells.every((c) => c === '—')).toBe(true);

  const batchCalls = () => fetchWithAuthMock.mock.calls.filter(([u]) => String(u).startsWith('/api/analytics/agent-stats/batch')).length;
  expect(batchCalls()).toBe(1);
  const retry = [...notice!.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.retry)!;
  await act(async () => { retry.click(); });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  expect(batchCalls()).toBe(2);
});

it('묶음은 성공인데 일부 에이전트만 빠지면 안내 없음(그 에이전트만 빈 지표)', async () => {
  mockWith({ [AGENTS[0]!.id]: { completed: 4, total_stories: 5, done_story_points: 0, avg_lead_time_ms: 0 } });
  await renderPanel();
  expect(container.querySelector('[data-testid="agent-stats-load-error"]')).toBeNull();
  expect(container.textContent).toContain('4');
});
