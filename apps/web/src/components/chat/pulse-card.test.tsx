// @vitest-environment jsdom
//
// story #3178(S3b) — chat 구심점 고정 「프로젝트 맥박」 카드. AC1(이사·collapsed 기본)·
// AC2(합산 불변식 — controlled expand 배선)·데이터 없으면 카드 자체가 안 보이는 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PulseCard } from './pulse-card';
import type { Overview } from '@/components/dashboard/command-center/types';

const { fetchWithAuthMock, useAutoRefreshMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  useAutoRefreshMock: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: (key: string, fn: () => void) => useAutoRefreshMock(key, fn) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const PENDING = { status: 'pending_data' as const };

function mockOverview(overrides: Partial<Overview['project_status']> = {}) {
  fetchWithAuthMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        scope: 'project',
        fleet: { total_agents: 0, status_breakdown: PENDING },
        project_status: {
          epics: [], outcome: { hit: 0, total: 0 }, recent_changes: [],
          risk: PENDING, cycle_time: PENDING, contribution: PENDING, cost_trend: PENDING,
          ...overrides,
        },
      },
    }),
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  useAutoRefreshMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('PulseCard — 재료 0이면 고정 카드가 첫 화면을 잠식하지 않는다', () => {
  it('전 지표 pending·에픽 없음이면 아무것도 렌더하지 않는다', async () => {
    mockOverview();
    await act(async () => { root.render(wrap(<PulseCard />)); });
    await flush();
    expect(container.textContent).toBe('');
  });

  it('fetch 실패해도 조용히 빈 상태(크래시 없음)', async () => {
    fetchWithAuthMock.mockRejectedValue(new Error('network'));
    await act(async () => { root.render(wrap(<PulseCard />)); });
    await flush();
    expect(container.textContent).toBe('');
  });
});

describe('PulseCard — AC1 collapsed 기본, 펼치면 지표', () => {
  it('collapsed 기본 — 헤더(프로젝트 맥박+활성 에픽 요약)만 보이고 지표 그리드는 안 보인다', async () => {
    mockOverview({ epics: [{ epic_id: 'e1', title: '결제 ②-B', status: 'active', total: 10, done: 6, completion_pct: 60 }] });
    await act(async () => { root.render(wrap(<PulseCard />)); });
    await flush();
    expect(container.textContent).toContain('프로젝트 맥박');
    expect(container.textContent).toContain('결제 ②-B');
    expect(container.textContent).not.toContain('사이클 타임');
  });

  it('헤더를 누르면 펼쳐져 지표 그리드가 보인다', async () => {
    mockOverview({ risk: { blocked: 0, failed_runs: 3, overdue: PENDING } });
    await act(async () => { root.render(wrap(<PulseCard />)); });
    await flush();
    const header = container.querySelector('button[aria-expanded]')!;
    await act(async () => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('최근 7일 실패 실행');
    expect(container.textContent).toContain('3');
  });
});

describe('PulseCard — AC2 합산 불변식(controlled expand 배선)', () => {
  it('expanded prop이 false면 펼침 클릭이 부모 콜백만 부르고 자체 펼치지 않는다(controlled)', async () => {
    mockOverview({ risk: { blocked: 0, failed_runs: 1, overdue: PENDING } });
    const onExpandedChange = vi.fn();
    await act(async () => { root.render(wrap(<PulseCard expanded={false} onExpandedChange={onExpandedChange} />)); });
    await flush();
    const header = container.querySelector('button[aria-expanded]')!;
    await act(async () => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    // 부모가 아직 expanded=false로 재렌더하지 않았으니(controlled) 지표는 여전히 안 보인다.
    expect(container.textContent).not.toContain('최근 7일 실패 실행');
  });

  it('expanded prop이 true로 넘어오면 클릭 없이도 펼쳐진 상태로 렌더된다', async () => {
    mockOverview({ risk: { blocked: 0, failed_runs: 1, overdue: PENDING } });
    await act(async () => { root.render(wrap(<PulseCard expanded onExpandedChange={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('최근 7일 실패 실행');
  });
});

describe('PulseCard — 폴링 배선(전역 RefreshContext 재사용, now-strip.tsx와 동형)', () => {
  it('useAutoRefresh가 고유 key로 등록된다', async () => {
    mockOverview();
    await act(async () => { root.render(wrap(<PulseCard />)); });
    await flush();
    expect(useAutoRefreshMock).toHaveBeenCalledWith('chat-pulse-card', expect.any(Function));
  });
});
