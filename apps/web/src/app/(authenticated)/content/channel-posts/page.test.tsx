// @vitest-environment jsdom
//
// story #3402(Phase1·마케팅운영, AC1/AC2/AC3) — 채널 포스트 목록 화면. content/page.test.tsx
// (site-posts)와 동형 harness(useDashboardContext 목·NextIntlClientProvider·createRoot·
// stubFetch) — 다섯 상태 파생 세부 분기는 channel-post-status.test.ts가 이미 잡으므로, 이
// 파일은 "목록 계약 필드가 화면에 정확히 배선됐는지"(N+1 없이 목록 응답만으로 렌더)와
// "채널 고유 신호(partialSuccess/publicationFailed)가 실제로 보이는지"만 pin한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import ChannelPostListPage from './page';

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

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function stubFetch(drafts: unknown[] | { status: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts`) {
        if (!Array.isArray(drafts)) return { ok: false, status: drafts.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: drafts, error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

const DRAFT_A = {
  draft_id: 'd1', work_item_id: 'w1', channel: 'threads', connection_id: 'c1',
  current_version: 2, latest_author_kind: 'human', updated_at: '2026-09-03T03:52:00+00:00',
  body_sha256: 'h1', gate_status: null, reapproval_required: null, sealed_content_sha256: null,
  published_at: null, publication_status: null,
};

describe('ChannelPostListPage (story #3402)', () => {
  it('0건 — 빈 상태(EmptyState) 안내(doc §2 — "새 글" 버튼 없음)', async () => {
    stubFetch([]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.channelPostsEmptyTitle);
    // AC(doc §2) — 빈 상태에 "새 글 작성" 류 CTA가 없다(에이전트 전용 생성 경로).
    expect(container.textContent).not.toContain('새 글');
  });

  // story #3422 ③-b — 캘린더 진입점.
  it('⭐캘린더 링크가 /content/channel-posts/calendar를 가리킨다(0건이어도 항상 보인다)', async () => {
    stubFetch([]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-posts-calendar-link"]')?.getAttribute('href'))
      .toBe('/content/channel-posts/calendar');
  });

  // story f30da19a AC5 — T1(목록).
  it('⭐AC5 — channel=sandbox면 칩 옆에 「테스트」 배지가 뜬다', async () => {
    stubFetch([{ ...DRAFT_A, channel: 'sandbox' }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')?.textContent)
      .toBe(koMessages.content.channelPostsSandboxTestBadge);
  });

  it('AC5 — channel=threads(실채널)면 배지가 없다', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')).toBeNull();
  });

  it('⭐목록 응답의 채널·버전·작성 주체·수정 시각이 화면에 그대로 나온다(AC1)', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.channelThreads);
    expect(container.textContent).toContain('v2');
    expect(container.textContent).toContain(koMessages.content.authorHuman);
  });

  it('⭐게이트/발행 신호가 전부 null인 행 — "초안" 상태로 렌더된다', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('draft');
  });

  it('⭐AC2 — gate_status 계약 필드 자체가 없는 행(구 계약)은 상태를 단정하지 않고 「—」를 그린다', async () => {
    const { gate_status: _drop, ...withoutGateContract } = DRAFT_A;
    stubFetch([withoutGateContract]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')).toBeNull();
    expect(container.textContent).toContain(koMessages.content.originAuthorUnknown);
  });

  it('⭐AC3 핵심 — publication_status=container_created(부분 성공)이 5상태 파생과 독립적으로 보인다', async () => {
    stubFetch([{
      ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
      publication_status: 'container_created',
    }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('approved');
    expect(container.querySelector('[data-testid="channel-post-partial-success"]')).not.toBeNull();
    expect(container.textContent).toContain(koMessages.content.channelPostsPartialSuccess);
  });

  it('⭐publication_status=failed — 발행 실패 배지가 보인다', async () => {
    stubFetch([{
      ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
      publication_status: 'failed', error_code: 'CHANNEL_PUBLISH_PROVIDER_ERROR',
    }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-publication-failed"]')).not.toBeNull();
  });

  it('publication_status=published(정상 발행) — 부분성공/실패 배지가 둘 다 안 보인다(회귀 방지)', async () => {
    stubFetch([{
      ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
      publication_status: 'published', published_at: '2026-09-03T18:44:00Z',
    }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-partial-success"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-publication-failed"]')).toBeNull();
    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('published');
  });

  // story #3402(PO 지시 2026-09-04) — text_preview/text_length는 디디군 후속 PR로 곧 착지.
  // 착지 전(지금)엔 응답에 필드 자체가 없다 — AC2와 같은 "키 부재≠null" 규율로 「—」를
  // 그리고, 첫 열 링크는 channel+version으로 폴백한다(navigable 유지).
  it('⭐text_preview/text_length 계약 필드 부재(착지 전) — 「—」로 떨어지고 첫 열은 channel+version 폴백', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-text-length"]')?.textContent).toBe(koMessages.content.originAuthorUnknown);
    expect(container.textContent).toContain(`${koMessages.content.channelThreads} · v2`);
  });

  it('⭐text_preview/text_length 계약 필드 존재(착지 후) — 본문 미리보기·글자 수가 그대로 보인다', async () => {
    stubFetch([{ ...DRAFT_A, text_preview: '마케팅 자동화가 실제로 아끼는 시간은…', text_length: 363 }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain('마케팅 자동화가 실제로 아끼는 시간은…');
    expect(container.querySelector('[data-testid="channel-post-text-length"]')?.textContent).toBe('363');
  });

  it('로드 실패 — 오류 알림을 보인다', async () => {
    stubFetch({ status: 500 });
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.channelPostsLoadFailed);
  });

  // story #3457 후속(유나 §14-2 안전 표기, PO 확定 2026-09-04 20:54Z) — 캘린더 카드·목록
  // 행·상세 3곳이 같은 어휘. 목록 행은 파생 표기만(배지는 상세 전용, 유나 정본).
  describe('같은 스토리의 글(목록 행, §14-2)', () => {
    it('source_content_item_id가 없으면(정상값) 이 줄 자체가 안 그려진다', async () => {
      stubFetch([DRAFT_A]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-post-source-link"]')).toBeNull();
    });

    it('⭐source_title이 있으면 "같은 스토리의 글" 링크가 행 안에 보인다', async () => {
      stubFetch([{ ...DRAFT_A, source_content_item_id: 'site-1', source_title: '9월 실험 회고' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const el = container.querySelector('[data-testid="channel-post-source-link"]');
      expect(el?.textContent).toContain(koMessages.content.channelPostsSourceLabel);
      expect(el?.textContent).toContain('9월 실험 회고');
      expect(el?.querySelector('a')?.getAttribute('href')).toBe('/content/site-1');
    });
  });
});
