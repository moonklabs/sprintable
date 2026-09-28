// @vitest-environment jsdom
// story #4231(2차 · 콘텐츠·조직) — 본문 flat 링크가 현재 프로젝트(`?p=`)를 싣는지 · 전환 대기 중이면 그 목표를 싣는지(4585와 같은 동작).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChannelPostCard } from './channel-post-card';
import { ResultsSummaryCards } from '@/components/insights-board/results-summary-cards';
import type { OrgCostSummaryLoadState } from '@/components/insights-board/org-cost-summary-card';
import { setPendingProjectTarget } from '@/lib/pending-project-switch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx = { projectId: 'proj-A' as string | undefined };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));
vi.mock('next/navigation', () => ({ useParams: () => ({}) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  ctx.projectId = 'proj-A';
  setPendingProjectTarget(null);
});

const NO_APPROVED_BOOSTS: OrgCostSummaryLoadState = {
  status: 'ok',
  summary: {
    ads: { approved_boost_count: 0, sealed_ads_currency: null, sealed_budget_minor: 0, captured_spend_minor: 0, remaining_minor: 0, cap_reached_count: 0, connection_status: 'not_connected' },
    generation_cost_spent_minor: null, generation_cost_period_start: null, generation_cost_period_end: null,
    generation_currency: null, x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
  },
};

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);
  });
}

const card = () => (
  <ChannelPostCard item={{ draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1', gate_status: null }} displayTimezone="Asia/Seoul" />
);

describe('콘텐츠·조직 flat 링크 `?p=`(story #4231)', () => {
  it('콘텐츠 캘린더 카드 → `/content/channel-posts/d1?p=proj-A`', async () => {
    await render(card());
    const href = container.querySelector('[data-testid="channel-post-calendar-card"]')?.closest('a')?.getAttribute('href')
      ?? container.querySelector('a')?.getAttribute('href');
    expect(href).toBe('/content/channel-posts/d1?p=proj-A');
  });

  it('프로젝트 전환 대기 중이면 그 목표 프로젝트를 싣는다', async () => {
    setPendingProjectTarget('proj-B');
    await render(card());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/content/channel-posts/d1?p=proj-B');
  });

  it('조직 결과 요약의 GA4 연결 CTA → `/organization/channels?p=proj-A`', async () => {
    await render(
      <ResultsSummaryCards
        publishedInWindow={null}
        viewsInWindow={null}
        ga4ConnectionStatus="not_connected"
        boardLoading={false}
        boardLoadFailed={false}
        costSummaryState={NO_APPROVED_BOOSTS}
        onRetryCostSummary={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="results-summary-organic-views-cta"]')?.getAttribute('href')).toBe('/organization/channels?p=proj-A');
  });

  it('프로젝트를 모르면 주소 그대로', async () => {
    ctx.projectId = undefined;
    await render(card());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/content/channel-posts/d1');
  });
});
