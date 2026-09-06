// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { InsightsBoardMetricCell } from './insights-board-metric-cell';
import type { InsightSnapshotBucketView } from './types';

function renderCell(bucket: InsightSnapshotBucketView | null, metric: string) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <CellHarness bucket={bucket} metric={metric} />
    </NextIntlClientProvider>,
  );
}

// next-intl 훅(useTranslations)은 컴포넌트 내부에서만 부를 수 있어 얇은 harness로 감싼다 —
// InsightsBoardMetricCell 자체는 tContent/tBoard를 인자로 받는 순수 프레젠테이션 컴포넌트다.
function CellHarness({ bucket, metric }: { bucket: InsightSnapshotBucketView | null; metric: string }) {
  const tContent = useTranslations('content');
  const tBoard = useTranslations('insightsBoard');
  return (
    <InsightsBoardMetricCell
      bucket={bucket}
      metric={metric as never}
      tContent={tContent}
      tBoard={tBoard}
    />
  );
}

// story #3583(페드루 PO 確定 2026-09-06 · 유나 §21-6-1) — captured인데 값이 null인
// 사유 3갈래 중 GA4 유입 지표(inflow_sessions/inflow_users)만 새 낱말(「GA4 미연결」),
// 나머지 5지표는 기존 「지표 미제공」 그대로.
describe('InsightsBoardMetricCell — GA4 유입 지표 null 사유(story #3583)', () => {
  const capturedBucket: InsightSnapshotBucketView = {
    status: 'captured', captured_at: '2026-09-06T00:00:00Z',
    normalized: {
      impressions: null, reach: null, views: 10, engagements: null, clicks: null, spend: null, conversions: null,
      inflow_sessions: null, inflow_users: null,
    },
  };

  it('기존 5지표(예: impressions) — 값 null이면 「지표 미제공」(회귀 0)', () => {
    const html = renderCell(capturedBucket, 'impressions');
    expect(html).toContain(koMessages.insightsBoard.insightsBoardMetricUnavailable);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
  });

  it('⭐inflow_sessions — 값 null이면 「GA4 미연결」(「지표 미제공」이 아니다)', () => {
    const html = renderCell(capturedBucket, 'inflow_sessions');
    expect(html).toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardMetricUnavailable);
  });

  it('⭐inflow_users — 값 null이면 「GA4 미연결」', () => {
    const html = renderCell(capturedBucket, 'inflow_users');
    expect(html).toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
  });

  it('inflow_sessions — 값이 있으면(GA4 연결됨) 그 값이 그대로 보인다(사유 문구 없음)', () => {
    const bucket: InsightSnapshotBucketView = {
      ...capturedBucket,
      normalized: { ...capturedBucket.normalized!, inflow_sessions: 42 },
    };
    const html = renderCell(bucket, 'inflow_sessions');
    expect(html).toContain('42');
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
  });
});
