// @vitest-environment jsdom
//
// story 1db41045(#3457) — campaign 상세. 소속 원문·변형·상태를 GET /campaigns/{id}
// 응답 그대로 보인다(조인 축을 화면이 새로 안 짠다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
const { useParamsMock } = vi.hoisted(() => ({ useParamsMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => useParamsMock(),
}));

import CampaignDetailPage from './page';

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
const CAMPAIGN_ID = 'c1';

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'owner' });
  useParamsMock.mockReturnValue({ campaignId: CAMPAIGN_ID });
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
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/organizations/${ORG_ID}/campaigns/${CAMPAIGN_ID}`) {
      return { ok: status < 400, status, json: async () => (status < 400 ? { data: body, error: null, meta: null } : body) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

describe('CampaignDetailPage(story 1db41045)', () => {
  it('⭐이름·상태·소속 원문·각 원문의 변형(채널+상태 칩)이 보이고 각각 상세로 링크된다', async () => {
    stubFetch(200, {
      id: CAMPAIGN_ID, name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active',
      created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00',
      content_items: [
        {
          content_item_id: 'site-1', slug: '9wol-post', lang: 'ko', title: '9월 실험 회고',
          current_version: 1, updated_at: '2026-09-04T00:00:00+00:00',
          variants: [
            { draft_id: 'cp-1', channel: 'threads', gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1', publication_status: null, published_at: null },
          ],
        },
      ],
    });
    await act(async () => { root.render(wrap(<CampaignDetailPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="campaign-detail-name"]')?.textContent).toBe('9월 캠페인');
    const item = container.querySelector('[data-testid="campaign-detail-content-item"]');
    expect(item?.querySelector('a')?.getAttribute('href')).toBe('/content/site-1');
    expect(item?.textContent).toContain('9월 실험 회고');

    const variantItem = container.querySelector('[data-testid="campaign-detail-variant-item"]');
    expect(variantItem?.querySelector('a')?.getAttribute('href')).toBe('/content/channel-posts/cp-1');
    expect(variantItem?.textContent).toContain(koMessages.content.channelThreads);
  });

  it('소속 원문이 0건이면 안내 문구만 보인다', async () => {
    stubFetch(200, {
      id: CAMPAIGN_ID, name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active',
      created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00', content_items: [],
    });
    await act(async () => { root.render(wrap(<CampaignDetailPage />)); });
    await flush();

    expect(container.textContent).toContain(koMessages.content.campaignNoContentItems);
    expect(container.querySelector('[data-testid="campaign-detail-content-item"]')).toBeNull();
  });

  it('⭐존재하지 않는 campaign(404)은 지어낸 화면 대신 안내 문구를 보인다', async () => {
    stubFetch(404, { detail: 'campaign을 찾을 수 없습니다: c1' });
    await act(async () => { root.render(wrap(<CampaignDetailPage />)); });
    await flush();

    expect(container.textContent).toContain(koMessages.content.campaignNotFound);
  });
});
