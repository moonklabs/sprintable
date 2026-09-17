// @vitest-environment jsdom
//
// story #3979(자리 옮김 ①) — 행 펼침 패널. 지표 선택(metricParam)과 무관하게
// «조회»(자연, views 고정) D+1/D+7을 항상 보이고, 광고 축은 ads_boost(지출/잔여)
// 그대로(AdsBoostSummaryView엔 «광고 조회» 수 자체가 없다 — 3977 §3, 지어내지
// 않는다).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { InsightsBoardRowDetail } from './insights-board-row-detail';
import type { Ga4ConnectionStatus, InsightsBoardRow } from './types';

function Harness({ row, ga4ConnectionStatus }: { row: InsightsBoardRow; ga4ConnectionStatus: Ga4ConnectionStatus }) {
  const tContent = useTranslations('content');
  const tBoard = useTranslations('insightsBoard');
  const tChannelConnect = useTranslations('channelConnect');
  return (
    <InsightsBoardRowDetail
      row={row} tBoard={tBoard} tContent={tContent} tChannelConnect={tChannelConnect}
      ga4ConnectionStatus={ga4ConnectionStatus} locale="ko"
    />
  );
}

function render(row: InsightsBoardRow, ga4ConnectionStatus: Ga4ConnectionStatus = 'connected') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <Harness row={row} ga4ConnectionStatus={ga4ConnectionStatus} />
    </NextIntlClientProvider>,
  );
}

const BASE_ROW: InsightsBoardRow = {
  publication_id: 'p1', kind: 'channel_publication', channel: 'threads', work_item_id: 'w1',
  title: '글', published_at: '2026-09-10T00:00:00Z', external_url: null, connection_id: 'c1',
  d1: { status: 'captured', captured_at: '2026-09-11T00:00:00Z', normalized: {
    impressions: null, reach: null, views: 100, engagements: null, clicks: null, spend: null, conversions: null,
    inflow_sessions: null, inflow_users: null, opens: null, delivered: null,
  } },
  d7: { status: 'captured', captured_at: '2026-09-17T00:00:00Z', normalized: {
    impressions: null, reach: null, views: 400, engagements: null, clicks: null, spend: null, conversions: null,
    inflow_sessions: null, inflow_users: null, opens: null, delivered: null,
  } },
  comments_count: 3, channel_post_draft_id: null, comments_last_collected_at: '2026-09-11T00:00:00Z',
  comments_supported: true, asset_sha256s: null, hook_key: null, command_status: null,
  ads_boost: null,
};

describe('InsightsBoardRowDetail(story #3979)', () => {
  it('⭐metricParam 무관하게 자연 조회 D+1/D+7 views를 항상 보인다', () => {
    const html = render(BASE_ROW);
    expect(html).toContain('100');
    expect(html).toContain('400');
  });

  it('⭐ads_boost가 null이면 「해당 없음」(지어낸 광고 조회 수 0)', () => {
    const html = render(BASE_ROW);
    expect(html).toContain(koMessages.insightsBoard.adsSpendNotApplicable);
  });

  it('ads_boost가 있으면(running) 지출/잔여 값을 보인다', () => {
    const withAds: InsightsBoardRow = {
      ...BASE_ROW,
      ads_boost: {
        gate_id: 'g1', gate_status: 'approved', sealed_budget_minor: 100_000, sealed_currency: 'KRW',
        captured_spend_minor: 40_000, remaining_minor: 60_000, run_status: 'running',
      },
    };
    const html = render(withAds);
    expect(html).not.toContain(koMessages.insightsBoard.adsSpendNotApplicable);
  });
});
