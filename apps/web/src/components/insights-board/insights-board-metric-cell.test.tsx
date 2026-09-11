// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { InsightsBoardMetricCell } from './insights-board-metric-cell';
import type { Ga4ConnectionStatus, InsightSnapshotBucketView } from './types';

function renderCell(bucket: InsightSnapshotBucketView | null, metric: string, ga4ConnectionStatus: Ga4ConnectionStatus = 'not_connected') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <CellHarness bucket={bucket} metric={metric} ga4ConnectionStatus={ga4ConnectionStatus} />
    </NextIntlClientProvider>,
  );
}

// next-intl 훅(useTranslations)은 컴포넌트 내부에서만 부를 수 있어 얇은 harness로 감싼다 —
// InsightsBoardMetricCell 자체는 tContent/tBoard/tChannelConnect를 인자로 받는 순수
// 프레젠테이션 컴포넌트다.
function CellHarness({ bucket, metric, ga4ConnectionStatus }: { bucket: InsightSnapshotBucketView | null; metric: string; ga4ConnectionStatus: Ga4ConnectionStatus }) {
  const tContent = useTranslations('content');
  const tBoard = useTranslations('insightsBoard');
  const tChannelConnect = useTranslations('channelConnect');
  return (
    <InsightsBoardMetricCell
      bucket={bucket}
      metric={metric as never}
      tContent={tContent}
      tBoard={tBoard}
      tChannelConnect={tChannelConnect}
      ga4ConnectionStatus={ga4ConnectionStatus}
    />
  );
}

// story #3583(페드루 PO 確定 2026-09-06 · 정정 2026-09-10) — captured인데 값이 null인
// 사유를 GA4 유입 지표(inflow_sessions/inflow_users)만 「지표 키 이름」이 아니라 org의
// 실 GA4 연결 상태(ga4_connection_status)로 가른다. 이전 주석("붙었는데 값만 없는
// 경우는 여기 안 온다")이 거짓으로 밝혀져(insight_snapshots.py의 GA4 처리 지연·일시
// OAuthError 경로) connected∧null이 실제로 온다 — 그 갈래가 「미연결」로 오판되면
// 이미 GA4를 붙인 org가 매번 "연결하세요"를 보게 되는 결함이었다.
describe('InsightsBoardMetricCell — GA4 유입 지표 null 사유 진리표(story #3583)', () => {
  const capturedBucket: InsightSnapshotBucketView = {
    status: 'captured', captured_at: '2026-09-06T00:00:00Z',
    normalized: {
      impressions: null, reach: null, views: 10, engagements: null, clicks: null, spend: null, conversions: null,
      inflow_sessions: null, inflow_users: null,
    },
  };

  it('행1 — non-GA4 지표(impressions)는 ga4_connection_status와 무관하게 「지표 미제공」(회귀 0)', () => {
    const html = renderCell(capturedBucket, 'impressions', 'connected');
    expect(html).toContain(koMessages.insightsBoard.insightsBoardMetricUnavailable);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4AggregationPending);
  });

  it('행2 — GA4 지표 + not_connected → 「GA4 미연결」', () => {
    const html = renderCell(capturedBucket, 'inflow_sessions', 'not_connected');
    expect(html).toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardMetricUnavailable);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4AggregationPending);
  });

  it('행3 — GA4 지표 + needs_reauth → 「다시 연결 필요」(channelStatusReauthRequired 재사용, 새 낱말 0)', () => {
    const html = renderCell(capturedBucket, 'inflow_sessions', 'needs_reauth');
    expect(html).toContain(koMessages.channelConnect.channelStatusReauthRequired);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4AggregationPending);
  });

  // ⭐뮤테이션 핀 — 이 결함의 핵심 갈래. 「지표 키 이름」만으로 추론하는 옛 로직으로
  // 되돌리면(ga4ConnectionStatus를 무시하고 GA4_INFLOW_METRICS만 검사) 이 행이
  // 「GA4 미연결」을 그리게 되어 RED가 나야 한다.
  it('행4 — GA4 지표 + connected → 「집계 대기」(미연결이 아니다 — 뮤테이션 핀)', () => {
    const html = renderCell(capturedBucket, 'inflow_sessions', 'connected');
    expect(html).toContain(koMessages.insightsBoard.insightsBoardGa4AggregationPending);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardMetricUnavailable);
  });

  it('inflow_users도 같은 진리표를 탄다(connected∧null → 집계 대기)', () => {
    const html = renderCell(capturedBucket, 'inflow_users', 'connected');
    expect(html).toContain(koMessages.insightsBoard.insightsBoardGa4AggregationPending);
  });

  it('값이 있으면(정상 수신) ga4_connection_status와 무관하게 그 값이 그대로 보인다(사유 문구 없음)', () => {
    const bucket: InsightSnapshotBucketView = {
      ...capturedBucket,
      normalized: { ...capturedBucket.normalized!, inflow_sessions: 42 },
    };
    const html = renderCell(bucket, 'inflow_sessions', 'connected');
    expect(html).toContain('42');
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4NotConnected);
    expect(html).not.toContain(koMessages.insightsBoard.insightsBoardGa4AggregationPending);
  });
});
