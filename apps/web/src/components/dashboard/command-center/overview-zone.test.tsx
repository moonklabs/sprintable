// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { OverviewZone } from './overview-zone';
import type { Overview } from './types';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

// story #2338 — 기대값은 backend/app/routers/command_center.py의 실제 반환 shape을 그대로
// 옮긴 것(독립 원본, 이 파일의 타입 정의에서 역산하지 않음). 2026-07-30 dev DB 라이브 실측과
// 같은 모양: risk={blocked,failed_runs,overdue}·cycle_time={avg_days,sample}·
// contribution={agent,human,unassigned}·cost_trend={points,total_cost_usd,delta_pct}.
const REAL_OVERVIEW: Overview = {
  scope: 'org',
  project_status: {
    epics: [],
    outcome: { hit: 0, total: 0 },
    recent_changes: [],
    risk: { blocked: 0, failed_runs: 42, overdue: { status: 'pending_data' } },
    cycle_time: { avg_days: 1.8, sample: 521 },
    contribution: { agent: 1195, human: 3, unassigned: 787 },
    cost_trend: { points: [], total_cost_usd: 0, delta_pct: null },
  },
  fleet: { total_agents: 14, status_breakdown: { online: 9, offline: 0, working: 5 } },
};

describe('OverviewZone real-data rendering (story #2338 — isPending 죽은 분기)', () => {
  it('renders the real failed_runs count, not the risk-pending placeholder', () => {
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={REAL_OVERVIEW} resolveName={() => null} />));
    expect(markup).toContain('최근 7일 실패 실행');
    expect(markup).toContain('>42<'); // failed_runs, distinctive value in its own element
    expect(markup).not.toContain('리스크 지표 준비중');
  });

  it('never renders blocked_cnt — #2224 판정대로 되살리지 않는다', () => {
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={REAL_OVERVIEW} resolveName={() => null} />));
    expect(markup).not.toMatch(/막힘|blocked/i);
  });

  it('lists both still-pending items in one combined §11-5 line (not scattered)', () => {
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={REAL_OVERVIEW} resolveName={() => null} />));
    expect(markup).toContain('아직 표시하지 않는 것 — 기한 초과 지표 · 비용 추세');
    expect(markup).toContain('준비되는 대로 표시됩니다.');
  });

  it('renders the real cycle-time average and sample, not the cycle-pending placeholder', () => {
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={REAL_OVERVIEW} resolveName={() => null} />));
    expect(markup).toContain('1.8');
    expect(markup).toContain('521');
    expect(markup).not.toContain('사이클 타임 준비중');
  });

  it('renders "no completions" copy (not pending) when the 30-day sample is genuinely zero', () => {
    const zeroSample: Overview = {
      ...REAL_OVERVIEW,
      project_status: { ...REAL_OVERVIEW.project_status, cycle_time: { avg_days: null, sample: 0 } },
    };
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={zeroSample} resolveName={() => null} />));
    expect(markup).toContain('최근 30일 완료 없음');
    expect(markup).not.toContain('사이클 타임 준비중');
  });

  it('renders the real agent/human/unassigned contribution breakdown, not the contribution-pending placeholder', () => {
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={REAL_OVERVIEW} resolveName={() => null} />));
    expect(markup).toContain('1195');
    expect(markup).toContain('787');
    expect(markup).not.toContain('기여 지표 준비중');
  });

  it('keeps cost_trend in the not-yet-shown list even though BE already sends a real (all-zero) object — $0 would lie', () => {
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={REAL_OVERVIEW} resolveName={() => null} />));
    expect(markup).toContain('비용 추세');
  });

  it('positive control: overdue drops out of the list on its own once BE ships a real overdue value — cost_trend stays', () => {
    // BE doesn't send this shape yet(#2338 AC1 — overdue is still genuinely unimplemented) —
    // this simulates the day it does, to prove the drop-out condition actually fires.
    const overdueResolved: Overview = {
      ...REAL_OVERVIEW,
      project_status: {
        ...REAL_OVERVIEW.project_status,
        risk: { ...REAL_OVERVIEW.project_status.risk, overdue: { count: 3 } as never },
      },
    };
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={overdueResolved} resolveName={() => null} />));
    expect(markup).toContain('아직 표시하지 않는 것 — 비용 추세');
    expect(markup).not.toContain('기한 초과 지표');
  });

  it('positive control: the whole not-yet-shown line disappears once every item resolves — no "모두 표시 중입니다" message', () => {
    const allResolved: Overview = {
      ...REAL_OVERVIEW,
      project_status: {
        ...REAL_OVERVIEW.project_status,
        risk: { ...REAL_OVERVIEW.project_status.risk, overdue: { count: 0 } as never },
        cost_trend: { points: [{ date: '2026-07-29', cost_usd: 12.5, tokens: 900 }], total_cost_usd: 12.5, delta_pct: null },
      },
    };
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={allResolved} resolveName={() => null} />));
    expect(markup).not.toContain('아직 표시하지 않는 것');
    expect(markup).not.toContain('모두 표시 중입니다');
  });

  it('still shows the pending placeholders when a field genuinely IS the whole-object PendingData sentinel', () => {
    const stillPending: Overview = {
      ...REAL_OVERVIEW,
      project_status: {
        ...REAL_OVERVIEW.project_status,
        risk: { status: 'pending_data' },
        cycle_time: { status: 'pending_data' },
        contribution: { status: 'pending_data' },
      },
    };
    const markup = renderToStaticMarkup(wrap(<OverviewZone data={stillPending} resolveName={() => null} />));
    expect(markup).toContain('리스크 지표 준비중');
    expect(markup).toContain('사이클 타임 준비중');
    expect(markup).toContain('기여 지표 준비중');
  });
});
