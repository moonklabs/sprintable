import { describe, expect, it } from 'vitest';
import type { Overview } from '@/components/dashboard/command-center/types';
import { buildPulseCardData, isPulseCardEmpty } from './derive-pulse-card';

const PENDING = { status: 'pending_data' as const };

function overview(overrides: Partial<Overview['project_status']> = {}): Overview {
  return {
    scope: 'project',
    fleet: { total_agents: 0, status_breakdown: PENDING },
    project_status: {
      epics: [],
      outcome: { hit: 0, total: 0 },
      recent_changes: [],
      risk: PENDING,
      cycle_time: PENDING,
      contribution: PENDING,
      cost_trend: PENDING,
      ...overrides,
    },
  };
}

describe('buildPulseCardData — AC1 이사(OverviewZone → pulse), 전 필드 pending graceful', () => {
  it('overview가 null이면(로딩 전) 전부 null', () => {
    const data = buildPulseCardData(null);
    expect(data).toEqual({ activeEpic: null, failedRuns: null, cycleTime: null, contribution: null, costTrend: null });
  });

  it('활성(status=active) 에픽이 없으면 activeEpic은 null', () => {
    const data = buildPulseCardData(overview({ epics: [{ epic_id: 'e1', title: 'X', status: 'done', total: 5, done: 5, completion_pct: 100 }] }));
    expect(data.activeEpic).toBeNull();
  });

  it('활성 에픽 1건을 골라 derivePhrase로 phrase를 매긴다(command-center.tsx 헤더와 동일 선택 로직)', () => {
    const data = buildPulseCardData(overview({
      epics: [
        { epic_id: 'e1', title: '완료됨', status: 'done', total: 5, done: 5, completion_pct: 100 },
        { epic_id: 'e2', title: '진행 중', status: 'active', total: 10, done: 6, completion_pct: 60 },
      ],
    }));
    expect(data.activeEpic).toEqual({ epicId: 'e2', title: '진행 중', phrase: 'almostThere', completionPct: 60 });
  });

  it('risk가 PendingData면 failedRuns는 null(#2338 계약 계승)', () => {
    expect(buildPulseCardData(overview()).failedRuns).toBeNull();
  });

  it('risk가 실 객체면 failed_runs 값을 그대로 낸다', () => {
    const data = buildPulseCardData(overview({ risk: { blocked: 0, failed_runs: 3, overdue: PENDING } }));
    expect(data.failedRuns).toBe(3);
  });

  it('cycle_time 실 객체는 avgDays/sample을 그대로 낸다', () => {
    const data = buildPulseCardData(overview({ cycle_time: { avg_days: 3.4, sample: 12 } }));
    expect(data.cycleTime).toEqual({ avgDays: 3.4, sample: 12 });
  });

  it('contribution 실 객체는 그대로 낸다', () => {
    const data = buildPulseCardData(overview({ contribution: { agent: 42, human: 3, unassigned: 1 } }));
    expect(data.contribution).toEqual({ agent: 42, human: 3, unassigned: 1 });
  });

  it('cost_trend 실 객체는 points를 cost_usd 배열로 평탄화한다', () => {
    const data = buildPulseCardData(overview({
      cost_trend: { total_cost_usd: 18, delta_pct: null, points: [{ date: '2026-08-20', cost_usd: 1, tokens: 100 }, { date: '2026-08-21', cost_usd: 5, tokens: 500 }] },
    }));
    expect(data.costTrend).toEqual({ totalUsd: 18, points: [1, 5] });
  });
});

describe('isPulseCardEmpty — 재료 0이면 고정 카드가 첫 화면을 잠식하지 않는다', () => {
  it('overview null이면 empty', () => {
    expect(isPulseCardEmpty(buildPulseCardData(null))).toBe(true);
  });

  it('전 필드 pending이고 에픽도 없으면 empty', () => {
    expect(isPulseCardEmpty(buildPulseCardData(overview()))).toBe(true);
  });

  it('activeEpic 하나만 있어도 empty가 아니다', () => {
    const data = buildPulseCardData(overview({ epics: [{ epic_id: 'e1', title: 'X', status: 'active', total: 1, done: 0, completion_pct: 0 }] }));
    expect(isPulseCardEmpty(data)).toBe(false);
  });

  it('집계 지표 하나만 있어도(에픽 없이) empty가 아니다', () => {
    const data = buildPulseCardData(overview({ risk: { blocked: 0, failed_runs: 1, overdue: PENDING } }));
    expect(isPulseCardEmpty(data)).toBe(false);
  });
});
