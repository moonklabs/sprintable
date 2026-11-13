// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import koMessages from '../../../messages/ko.json';

// story 4912 (D) — the statistics tab on the ds parts (`wide` PageFrame · PageHead with the scope chip · one DetailCard per section · Metric numbers · ProgressBar velocity · Chip rank/balance), and a FAILED read is never
// shown as «none»: a failed / rejected / unreadable members read used to say «배포된 에이전트가 없어요», a failed velocity read «스프린트 데이터가 없어요», a failed leaderboard read listed nobody (rank/«0 TJSB» as if known).
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'proj-1' }) }));
const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));
import { AgentPerformancePanel } from './agent-performance-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const P = koMessages.agentPerformance;
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); fetchWithAuthMock.mockReset(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const AGENTS = [{ id: 'ag-1', name: '알파', type: 'agent' }, { id: 'ag-2', name: '베타', type: 'agent' }];
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
const SPRINTS = [{ id: 's1', title: '스프린트 1', velocity: 8, status: 'closed', start_date: null, end_date: null }, { id: 's2', title: '스프린트 2', velocity: 4, status: 'closed', start_date: null, end_date: null }];
type Fail = 'none' | 'members500' | 'membersReject' | 'membersUnreadable' | 'velocity500' | 'leaderboard500' | 'leaderboard204' | 'velocityString' | 'leaderboardWithoutAg1' | 'velocityZeros';
function mockReads(fail: Fail = 'none') {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/team-members')) {
      if (fail === 'members500') return { ok: false, status: 500, json: async () => ({}) };
      if (fail === 'membersReject') throw new TypeError('network down');
      if (fail === 'membersUnreadable') return { ok: true, json: async () => { throw new SyntaxError('unreadable'); } };
      return ok(AGENTS);
    }
    if (url.startsWith('/api/analytics/velocity-history')) {
      if (fail === 'velocity500') return { ok: false, status: 500, json: async () => ({}) };
      if (fail === 'velocityString') return ok('not a list');
      if (fail === 'velocityZeros') return ok(SPRINTS.map((x) => ({ ...x, velocity: 0 })));
      return ok(SPRINTS);
    }
    if (url.startsWith('/api/rewards/leaderboard')) {
      if (fail === 'leaderboard500') return { ok: false, status: 500, json: async () => ({}) };
      if (fail === 'leaderboard204') return ok({ ok: true }); // the proxy route turns a 204 into { data: { ok: true } }
      if (fail === 'leaderboardWithoutAg1') return ok([{ member_id: 'ag-2', balance: 120 }]);
      return ok([{ member_id: 'ag-1', balance: 50 }, { member_id: 'ag-2', balance: 120 }]);
    }
    if (url.startsWith('/api/analytics/agent-stats/batch')) return ok({ 'ag-1': { completed: 7, total_stories: 9, done_story_points: 0, avg_lead_time_ms: 7_200_000 }, 'ag-2': { completed: 3, total_stories: 3, done_story_points: 0, avg_lead_time_ms: 0 } });
    return { ok: false, json: async () => ({}) };
  });
}
async function render() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentPerformancePanel /></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}
const banner = () => container.querySelector('[data-testid="agent-stats-load-error"] [data-slot="ds-banner"]') as HTMLElement | null;
const text = () => container.textContent ?? '';

describe('AgentPerformancePanel — 4912 D: the ds face', () => {
  it('⭐wide 틀 · 쪽 머리(설명 + «이 프로젝트» 칩) · 구획마다 ds 카드 셋 · 에이전트 줄의 숫자는 Metric · 순위 · 잔액은 Chip', async () => {
    mockReads();
    await render();
    const frame = container.querySelector('[data-slot="ds-page-frame"]')!;
    expect(frame.getAttribute('data-width')).toBe('wide');
    expect(container.querySelector('[data-slot="ds-page-head"]')?.textContent).toContain(koMessages.agents.scopeThisProject);
    expect(container.querySelector('[data-slot="ds-page-head"] [data-slot="ds-chip"]')?.getAttribute('data-tone')).toBe('info');
    for (const id of ['agent-stats-card', 'agent-velocity-card', 'agent-leaderboard-card']) expect(container.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-slot'), id).toBe('ds-card');
    const row = container.querySelector('[data-testid="agent-stats-row-ag-1"]')!;
    const metrics = [...row.querySelectorAll('[data-slot="ds-metric"]')].map((m) => [m.querySelector('dt')?.textContent, m.querySelector('dd')?.textContent]);
    expect(metrics).toEqual([[P.doneStories, '7'], [P.assignedStories, '9'], [P.avgLeadTime, '2h']]);
    expect([...row.querySelectorAll('[data-slot="ds-chip"]')].map((c) => c.textContent)).toEqual(['#2', '50 TJSB']);
    expect(banner()).toBeNull();
  });

  it('⭐벨로시티 = ProgressBar(스프린트 이름이 접근 이름 · 가장 큰 값이 가득) · 리더보드는 잔액 순', async () => {
    mockReads();
    await render();
    const bars = [...container.querySelectorAll('[data-testid="agent-velocity-card"] [role="progressbar"]')] as HTMLElement[];
    expect(bars.map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-valuenow'), b.getAttribute('aria-valuemax')])).toEqual([['스프린트 1', '8', '8'], ['스프린트 2', '4', '8']]);
    const order = [...container.querySelectorAll('[data-testid="agent-leaderboard-card"] li')].map((li) => li.textContent);
    expect(order[0]).toContain('베타'); // 120 first
    expect(order[1]).toContain('알파');
  });

  it('⭐소스: ui/* · lucide · SectionCard · 옛 글자 크기 · 색 토큰이 없다 — 되돌리면 RED', () => {
    const src = readFileSync(join(__dirname, 'agent-performance-panel.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(src).not.toMatch(/from '@\/components\/ui\//);
    expect(src).not.toContain('lucide-react');
    for (const bad of ['SectionCard', 'text-muted-foreground', 'text-sm', 'text-xs', 'text-warning-strong', 'bg-border', 'text-success', 'bg-primary']) expect(src, bad).not.toContain(bad);
  });
});

describe('AgentPerformancePanel — 4912 D: a failed read is not «none»', () => {
  for (const fail of ['members500', 'membersReject', 'membersUnreadable'] as const) {
    it(`⭐에이전트 읽기가 실패하면(${fail}) «배포된 에이전트가 없어요»가 아니라 실패 띠 + [다시 시도] — 에이전트 · 리더보드 카드는 그리지 않는다`, async () => {
      mockReads(fail);
      await render();
      expect(banner()?.getAttribute('data-tone')).toBe('failed');
      expect(banner()?.getAttribute('role')).toBe('alert');
      expect(banner()?.textContent).toContain(P.agentStatsLoadError);
      expect(text()).not.toContain(P.noAgents);
      expect(container.querySelector('[data-testid="agent-stats-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="agent-leaderboard-card"]')).toBeNull();
    });
  }

  it('⭐벨로시티 읽기만 실패하면 그 카드가 «스프린트 데이터를 읽지 못했어요»(= «스프린트 데이터가 없어요»가 아니다) · 에이전트 줄은 그대로 · 실패 띠', async () => {
    mockReads('velocity500');
    await render();
    expect(container.querySelector('[data-testid="agent-velocity-load-failed"]')?.textContent).toBe(P.velocityLoadFailed);
    expect(text()).not.toContain(P.noSprintData);
    expect(container.querySelector('[data-testid="agent-stats-row-ag-1"]')).not.toBeNull();
    expect(banner()).not.toBeNull();
  });

  it('⭐리더보드 읽기만 실패하면 순위 · «0 TJSB»를 아는 것처럼 그리지 않는다 — 카드는 «순위를 읽지 못했어요» · 줄에 칩 없음 · 실패 띠', async () => {
    mockReads('leaderboard500');
    await render();
    expect(container.querySelector('[data-testid="agent-leaderboard-load-failed"]')?.textContent).toBe(P.leaderboardLoadFailed);
    expect(text()).not.toContain('TJSB');
    expect(container.querySelector('[data-testid="agent-stats-row-ag-1"] [data-slot="ds-chip"]')).toBeNull();
    expect(banner()).not.toBeNull();
  });

  it('⭐리더보드가 204(= { ok: true } 표지)로 «없음»이면 실패가 아니다 — 에이전트 줄은 서고 «0 TJSB»(알려진 없음) · 띠 없음 · 에이전트 읽기 실패로 둔갑하지 않는다(codex)', async () => {
    mockReads('leaderboard204');
    await render();
    expect(banner()).toBeNull();
    expect(container.querySelector('[data-testid="agent-stats-row-ag-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-stats-row-ag-1"]')!.textContent).toContain('0 TJSB');
    expect(container.querySelector('[data-testid="agent-leaderboard-load-failed"]')).toBeNull();
  });

  it('⭐리스트로 읽을 수 없는 모양(문자열)이 오면 «없음»이 아니라 실패 — 벨로시티 카드가 «읽지 못했어요» · 띠(codex: 예전엔 .slice에서 던졌다)', async () => {
    mockReads('velocityString');
    await render();
    expect(container.querySelector('[data-testid="agent-velocity-load-failed"]')?.textContent).toBe(P.velocityLoadFailed);
    expect(banner()).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-stats-row-ag-1"]')).not.toBeNull();
  });

  it('리더보드에 없는 에이전트는 순위 칩 없이 «0 TJSB»만(읽기는 성공 — 순위만 모른다) · 벨로시티 값이 전부 0이어도 막대가 선다(codex 시험 공백)', async () => {
    mockReads('leaderboardWithoutAg1');
    await render();
    expect([...container.querySelectorAll('[data-testid="agent-stats-row-ag-1"] [data-slot="ds-chip"]')].map((c) => c.textContent)).toEqual(['0 TJSB']);
    expect([...container.querySelectorAll('[data-testid="agent-stats-row-ag-2"] [data-slot="ds-chip"]')].map((c) => c.textContent)).toEqual(['#1', '120 TJSB']);
    mockReads('velocityZeros');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><div key="again"><AgentPerformancePanel /></div></NextIntlClientProvider>); });
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    const bars = [...container.querySelectorAll('[data-testid="agent-velocity-card"] [role="progressbar"]')];
    expect(bars).toHaveLength(2);
  });

  it('⭐[다시 시도]는 셋 다 다시 읽는다 — 고쳐진 뒤엔 띠가 사라지고 에이전트 줄이 선다', async () => {
    mockReads('members500');
    await render();
    const before = fetchWithAuthMock.mock.calls.length;
    mockReads('none');
    const retry = [...banner()!.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.retry)!;
    await act(async () => { retry.click(); });
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    expect(fetchWithAuthMock.mock.calls.length).toBeGreaterThan(before + 2);
    expect(banner()).toBeNull();
    expect(container.querySelector('[data-testid="agent-stats-row-ag-1"]')).not.toBeNull();
  });
});
