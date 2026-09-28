// @vitest-environment jsdom
//
// story #3979(시안 ④ 배치) — 기존 page.test.tsx(성과 보드 8열·필터·행동 회귀)와
// 별도 파일로 분리한다(그 파일은 무수정 — 「기존 테스트 무수정 GREEN」이 곧
// 「기능 삭제 0」의 증거, 새 회귀는 여기서만 확認). 커버:
//  ① 요약 4칸이 표보다 위에 뜬다.
//  ② 필터 7종은 기본 접힘(CSS만 — DOM에서 빠지지 않는다, 기존 page.test.tsx의
//     querySelector 전제가 살아 있는 이유가 이거다) + 토글로 펼쳐진다.
//  ③ 발행 신뢰도 절은 기본 접힘(마운트 자체 안 함) + 토글로 펼쳐진다.
//  ④ 행 펼침 토글 — 기본 접힘, 클릭하면 자연 조회 D+1/D+7 패널이 뜬다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, useSearchParamsMock, routerReplaceMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  useSearchParamsMock: vi.fn(),
  routerReplaceMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => useSearchParamsMock(),
  useRouter: () => ({ replace: routerReplaceMock }),
}));

import InsightsBoardPage from './page';

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

const ORG_ID = 'org-1';

const ROW_A = {
  publication_id: 'pub-a', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-a',
  title: '글 A', published_at: '2026-09-01T00:00:00Z', external_url: null, connection_id: 'conn-1',
  d1: { status: 'captured', normalized: { impressions: null, reach: null, views: 10, engagements: null, clicks: null, spend: null, conversions: null }, captured_at: '2026-09-02T00:00:00Z' },
  d7: { status: 'captured', normalized: { impressions: null, reach: null, views: 40, engagements: null, clicks: null, spend: null, conversions: null }, captured_at: '2026-09-08T00:00:00Z' },
  comments_count: 0, channel_post_draft_id: null, comments_last_collected_at: null, comments_supported: true,
  asset_sha256s: null, hook_key: null, command_status: null, ads_boost: null,
};

function stubFetch(opts: { published_in_window?: unknown; views_in_window?: unknown } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/insights-board/cost-summary')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            ads: { approved_boost_count: 0, sealed_ads_currency: null, sealed_budget_minor: 0, captured_spend_minor: 0, remaining_minor: 0, cap_reached_count: 0 },
            generation_cost_spent_minor: null, generation_cost_period_start: null, generation_cost_period_end: null,
            generation_currency: null, x_cost_spent_minor: null,
          },
          error: null, meta: null,
        }),
      } as Response;
    }
    if (url.includes('/insights-board')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            rows: [ROW_A], has_more: false, next_cursor: null, hidden_count: null,
            ga4_connection_status: 'not_connected',
            published_in_window: opts.published_in_window ?? null,
            views_in_window: opts.views_in_window ?? null,
          },
          error: null, meta: null,
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ data: null, error: { code: 'NOT_FOUND' } }) } as Response;
  }));
}

beforeEach(() => {
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
  routerReplaceMock.mockReset();
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, currentMemberType: 'human' });
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

async function mount() {
  await act(async () => { root.render(wrap(<InsightsBoardPage />)); });
  await flush();
}

describe('InsightsBoardPage v3(story #3979) — 요약 4칸', () => {
  it('⭐응답에 published_in_window/views_in_window가 있으면 실값이 표보다 위에 뜬다', async () => {
    stubFetch({
      published_in_window: { count: 3, by_channel: [], since: '2026-09-10T00:00:00Z' },
      views_in_window: { sum: 50, captured_rows: 1, total_rows: 1 },
    });
    await mount();
    expect(container.querySelector('[data-testid="results-summary-published-value"]')?.textContent).toBe('3');
    expect(container.querySelector('[data-testid="results-summary-organic-views-value"]')?.textContent).toBe('50');
  });

  it('⭐3978 필드가 없으면(응답에 키 자체가 없는 develop 미착지 상황도 포함) 「미측정」', async () => {
    stubFetch();
    await mount();
    expect(container.querySelector('[data-testid="results-summary-published-unmeasured"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-organic-views-unmeasured"]')).not.toBeNull();
  });
});

describe('InsightsBoardPage v3(story #3979) — 필터 접힘(자리 옮김 ④)', () => {
  it('⭐기본 접힘(hidden 클래스) — 그래도 기존 필터 엘리먼트는 DOM에 그대로 있다', async () => {
    stubFetch();
    await mount();
    const panel = container.querySelector('[data-testid="insights-board-filters-panel"]');
    expect(panel?.className).toContain('hidden');
    expect(container.querySelector('[data-testid="insights-board-channel-filter"]')).not.toBeNull();
  });

  it('토글 클릭하면 hidden이 빠진다', async () => {
    stubFetch();
    await mount();
    const toggle = container.querySelector('[data-testid="insights-board-filters-toggle"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    const panel = container.querySelector('[data-testid="insights-board-filters-panel"]');
    expect(panel?.className).not.toContain('hidden');
  });
});

describe('InsightsBoardPage v3(story #3979) — 발행 신뢰도 절(자리 옮김 ⑤)', () => {
  it('⭐기본 접힘 — PublishingMetricsBand 자체가 마운트되지 않는다', async () => {
    stubFetch();
    await mount();
    expect(container.querySelector('[data-testid="insights-board-publishing-trust-body"]')).toBeNull();
  });

  it('토글 클릭하면 펼쳐진다', async () => {
    stubFetch();
    await mount();
    const toggle = container.querySelector('[data-testid="insights-board-publishing-trust-toggle"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    await flush();
    expect(container.querySelector('[data-testid="insights-board-publishing-trust-body"]')).not.toBeNull();
  });
});

describe('InsightsBoardPage v3(story #3979) — 행 펼침(자리 옮김 ①)', () => {
  it('⭐기본 접힘 — 상세 행이 없다', async () => {
    stubFetch();
    await mount();
    expect(container.querySelector('[data-testid="insights-board-row-detail-row"]')).toBeNull();
  });

  it('⭐펼치면 자연 조회 D+1/D+7이 metricParam과 무관하게 뜬다', async () => {
    stubFetch();
    await mount();
    const toggle = container.querySelector('[data-testid="insights-board-row-expand-toggle"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    const detailRow = container.querySelector('[data-testid="insights-board-row-detail-row"]');
    expect(detailRow).not.toBeNull();
    expect(detailRow?.textContent).toContain('10');
    expect(detailRow?.textContent).toContain('40');
  });
});
