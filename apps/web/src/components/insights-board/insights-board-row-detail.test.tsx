// @vitest-environment jsdom
//
// story #3979(자리 옮김 ①) — 행 펼침 패널. 지표 선택(metricParam)과 무관하게
// «조회»(자연, views 고정) D+1/D+7을 항상 보이고, 광고 축은 ads_boost(지출/잔여)
// 그대로(AdsBoostSummaryView엔 «광고 조회» 수 자체가 없다 — 3977 §3, 지어내지
// 않는다).
//
// story #3979 CHANGES(페드루 PO 2026-09-17 01:14Z) — 댓글·후속 조치·원본과 대조
// 를 표(page.tsx)에서 여기로 진짜 옮겼다 — 이 패널이 이제 그 셋도 렌더한다.
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { InsightsBoardRowDetail, type InsightsBoardRowDetailProps } from './insights-board-row-detail';
import type { Ga4ConnectionStatus, InsightsBoardRow } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessOverrides = Partial<Omit<InsightsBoardRowDetailProps, 'row' | 'tBoard' | 'tContent' | 'tChannelConnect'>>;

function Harness({ row, ga4ConnectionStatus, overrides }: { row: InsightsBoardRow; ga4ConnectionStatus: Ga4ConnectionStatus; overrides?: HarnessOverrides }) {
  const tContent = useTranslations('content');
  const tBoard = useTranslations('insightsBoard');
  const tChannelConnect = useTranslations('channelConnect');
  return (
    <InsightsBoardRowDetail
      row={row} tBoard={tBoard} tContent={tContent} tChannelConnect={tChannelConnect}
      ga4ConnectionStatus={ga4ConnectionStatus} locale="ko" rowIndex={0}
      canCreateFollowUp={true} canReconcile={true} onFollowUp={vi.fn()} onReconcile={vi.fn()} reconcileLoading={false}
      {...overrides}
    />
  );
}

function renderStatic(row: InsightsBoardRow, ga4ConnectionStatus: Ga4ConnectionStatus = 'connected', overrides?: HarnessOverrides) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <Harness row={row} ga4ConnectionStatus={ga4ConnectionStatus} overrides={overrides} />
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
    const html = renderStatic(BASE_ROW);
    expect(html).toContain('100');
    expect(html).toContain('400');
  });

  it('⭐ads_boost가 null이면 「해당 없음」(지어낸 광고 조회 수 0)', () => {
    const html = renderStatic(BASE_ROW);
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
    const html = renderStatic(withAds);
    expect(html).not.toContain(koMessages.insightsBoard.adsSpendNotApplicable);
  });

  // story #3979 CHANGES — 댓글·행동 버튼이 이제 이 패널 안에 있다(page.tsx
  // 플랫 열/버튼 제거).
  it('⭐댓글 칸이 패널 안에 있다(자리 옮김 ③)', () => {
    const html = renderStatic(BASE_ROW);
    expect(html).toContain('data-testid="insights-board-comments-cell"');
  });

  it('⭐canCreateFollowUp/canReconcile 둘 다 true면 두 버튼이 다 보인다', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <Harness row={BASE_ROW} ga4ConnectionStatus="connected" />
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector('[data-testid="insights-board-follow-up-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="insights-board-reconcile-button"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('⭐canCreateFollowUp=false·canReconcile=false면 행동 영역 자체가 없다', () => {
    const html = renderStatic(BASE_ROW, 'connected', { canCreateFollowUp: false, canReconcile: false });
    expect(html).not.toContain('data-testid="insights-board-follow-up-button"');
    expect(html).not.toContain('data-testid="insights-board-reconcile-button"');
  });
});
