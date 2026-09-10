// @vitest-environment jsdom
//
// story #3697(Phase2·FE, 유나 § 確定 2026-09-08) — story 단위 blog↔social 성과 대조.
// 핵심 계약: ① rows 0건이면 섹션 자체 무표시 ② 매체가 선언 안 한 지표는 행 자체를 안
// 그린다(declaredMetricsForChannel) ③ views 행에만 출처 한 마디가 붙는다(블로그=사이트
// 방문 집계·소셜=채널 API) ④ 소셜 여러 채널은 합산 없이 발행물별 카드로 나란히.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { InsightSnapshotBucketView, InsightsBoardRow } from './types';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import { StoryInsightsCompareSection } from './story-insights-compare-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubFetchRows(rows: InsightsBoardRow[], hasMore = false) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ data: { rows, has_more: hasMore, next_cursor: null } }),
  })));
}

const capturedBucket = (overrides: Partial<InsightSnapshotBucketView['normalized']> = {}): InsightSnapshotBucketView => ({
  status: 'captured',
  captured_at: '2026-09-08T00:00:00Z',
  normalized: {
    impressions: null, reach: null, views: 100, engagements: null, clicks: null, spend: null, conversions: null,
    inflow_sessions: null, inflow_users: null,
    ...overrides,
  },
});

function blogRow(overrides: Partial<InsightsBoardRow> = {}): InsightsBoardRow {
  return {
    publication_id: 'pub-blog', kind: 'site_post', channel: 'hosted_site', work_item_id: 'story-1',
    title: '블로그 글', published_at: '2026-09-01T00:00:00Z', external_url: 'https://example.com/post',
    connection_id: null, d1: capturedBucket(), d7: capturedBucket(),
    comments_count: null, channel_post_draft_id: null, comments_last_collected_at: null, comments_supported: false,
    asset_sha256s: null, hook_key: null, command_status: null,
    ...overrides,
  };
}

function socialRow(overrides: Partial<InsightsBoardRow> = {}): InsightsBoardRow {
  return {
    publication_id: 'pub-social', kind: 'channel_publication', channel: 'threads', work_item_id: 'story-1',
    title: '소셜 포스트', published_at: '2026-09-01T00:00:00Z', external_url: null,
    connection_id: 'conn-1', d1: capturedBucket(), d7: capturedBucket(),
    comments_count: 3, channel_post_draft_id: 'draft-1', comments_last_collected_at: '2026-09-02T00:00:00Z', comments_supported: true,
    asset_sha256s: null, hook_key: null, command_status: null,
    ...overrides,
  };
}

describe('StoryInsightsCompareSection — story #3697', () => {
  it('rows 0건이면 섹션 자체가 렌더되지 않는다(AC1)', async () => {
    stubFetchRows([]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="story-insights-compare-section"]')).toBeNull();
  });

  it('orgId가 없으면(마운트 전 컨텍스트 미확定) 렌더되지 않는다', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: undefined });
    stubFetchRows([blogRow()]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="story-insights-compare-section"]')).toBeNull();
  });

  it('blog·social 행을 각 축 카드로 나눠 그린다', async () => {
    stubFetchRows([blogRow(), socialRow()]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    expect(container.textContent).toContain(koMessages.insightsBoard.storyCompareAxisBlog);
    expect(container.textContent).toContain(koMessages.insightsBoard.storyCompareAxisSocial);
    const cards = container.querySelectorAll('[data-testid="story-compare-publication-card"]');
    expect(cards).toHaveLength(2);
  });

  it('블로그(hosted_site) 카드는 views·clicks만 그린다(engagements 등 미선언 지표는 행 자체가 없다)', async () => {
    stubFetchRows([blogRow()]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    const card = container.querySelector('[data-testid="story-compare-publication-card"]')!;
    expect(card.textContent).toContain(koMessages.content.insightMetricViews);
    expect(card.textContent).toContain(koMessages.content.insightMetricClicks);
    expect(card.textContent).not.toContain(koMessages.content.insightMetricEngagements);
    expect(card.textContent).not.toContain(koMessages.content.insightMetricImpressions);
  });

  it('소셜(threads) 카드는 views·engagements만 그린다(clicks 등 미선언 지표는 없다)', async () => {
    stubFetchRows([socialRow()]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    const card = container.querySelector('[data-testid="story-compare-publication-card"]')!;
    expect(card.textContent).toContain(koMessages.content.insightMetricViews);
    expect(card.textContent).toContain(koMessages.content.insightMetricEngagements);
    expect(card.textContent).not.toContain(koMessages.content.insightMetricClicks);
  });

  it('views 행에만 출처 한 마디가 붙는다(블로그=사이트 방문 집계, 소셜=채널 API) — 유나 § 핵심', async () => {
    stubFetchRows([blogRow(), socialRow()]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    const cards = [...container.querySelectorAll('[data-testid="story-compare-publication-card"]')];
    const blogCard = cards.find((c) => c.textContent?.includes('블로그 글'))!;
    const socialCard = cards.find((c) => c.textContent?.includes('소셜 포스트'))!;
    expect(blogCard.textContent).toContain(koMessages.insightsBoard.storyCompareSourceSiteBeacon);
    expect(blogCard.textContent).not.toContain(koMessages.insightsBoard.storyCompareSourceChannelApi);
    expect(socialCard.textContent).toContain(koMessages.insightsBoard.storyCompareSourceChannelApi);
    expect(socialCard.textContent).not.toContain(koMessages.insightsBoard.storyCompareSourceSiteBeacon);
  });

  it('소셜 여러 채널(threads+instagram)은 합산하지 않고 카드 2장으로 나란히 그린다(AC 유나 §④)', async () => {
    stubFetchRows([
      socialRow({ publication_id: 'pub-threads', channel: 'threads' }),
      socialRow({ publication_id: 'pub-ig', channel: 'instagram', title: 'IG 포스트' }),
    ]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    const cards = container.querySelectorAll('[data-testid="story-compare-publication-card"]');
    expect(cards).toHaveLength(2);
  });

  it('captured인데 지표 값이 null이면 「지표 미제공」(AC2 — 0과 구분, InsightsBoardMetricCell 재사용)', async () => {
    stubFetchRows([blogRow({ d1: capturedBucket({ views: null }) })]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();
    expect(container.textContent).toContain(koMessages.insightsBoard.insightsBoardMetricUnavailable);
  });

  // story #3746(유나 v5, 2026-09-09) — InsightsBoardMetricCell의 pending 셀 라벨이
  // 「대기 중」(insightStatusPending)에서 「아직」(insightStatusWaiting)으로 바뀌었다
  // (pending·in_progress 공용 — 다음 발이 같다). 이 컴포넌트가 그 셀을 재사용하므로
  // 여기도 같이 바뀐다.
  it('d7 버킷 status가 pending이면 「아직」(AC3 — 수집 예정, InsightsBoardMetricCell 재사용)', async () => {
    stubFetchRows([blogRow({ d7: { status: 'pending', normalized: null, captured_at: null } })]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();
    expect(container.textContent).toContain(koMessages.content.insightStatusWaiting);
  });

  it('발행물 카드에 후속 조치 버튼이 있고 클릭하면 FollowUpDialog가 뜬다(AC4)', async () => {
    stubFetchRows([blogRow()]);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    const button = container.querySelector('[data-testid="story-compare-follow-up-button"]') as HTMLButtonElement;
    expect(button).toBeDefined();
    await act(async () => { button.click(); });
    // Dialog가 Portal로 document.body에 렌더된다(container 밖).
    expect(document.body.textContent).toContain(koMessages.insightsBoard.followUpDialogTitle);
  });

  it('fetch가 work_item_id·window 쿼리를 정확히 싣는다(#4047 계약)', async () => {
    const fetchSpy = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ data: { rows: [], has_more: false, next_cursor: null } }) }));
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-42" />)); });
    await flush();

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/api/organizations/org-1/insights-board?');
    expect(calledUrl).toContain('work_item_id=story-42');
    expect(calledUrl).toContain('window=90d');
  });

  // story #3697(유나 § ②) — has_more는 kind별 상한에 잘린 게 있다는 뜻(수는 모른다) —
  // 섹션 수준 한 줄 배너로만 정직하게 알린다(특정 축 밑이 아니다 — has_more가 어느 축이
  // 잘렸는지 말 안 해서 축 밑에 붙이면 모르는 것을 단정하게 된다).
  it('has_more=true면 섹션 수준 "일부 표시 안 됨" 배너가 뜬다(유나 § 카피 그대로)', async () => {
    stubFetchRows([blogRow(), socialRow()], true);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    const notice = container.querySelector('[data-testid="story-compare-partial-notice"]');
    expect(notice).toBeDefined();
    expect(notice?.textContent).toBe(koMessages.insightsBoard.storyComparePartialNotice);
  });

  it('has_more=false면 배너가 안 뜬다(정직 — 안 잘렸는데 잘렸다고 안 함)', async () => {
    stubFetchRows([blogRow(), socialRow()], false);
    await act(async () => { root.render(wrap(<StoryInsightsCompareSection storyId="story-1" />)); });
    await flush();

    expect(container.querySelector('[data-testid="story-compare-partial-notice"]')).toBeNull();
  });
});
