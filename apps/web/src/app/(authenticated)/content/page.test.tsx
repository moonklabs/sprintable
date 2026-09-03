// @vitest-environment jsdom
//
// story #3368(Phase0·마케팅운영 S4) — 글 목록 화면(S1·S2 와이어프레임). organization/
// connectors/page.test.tsx와 동형 harness(useDashboardContext 목·NextIntlClientProvider·
// createRoot·stubFetch). 오늘 시점(S1 목록 계약만 착지)엔 게이트/봉인 해시 신호가 응답에
// 없어 모든 행이 '초안'으로만 파생되는 것을 고정한다 — S2·S3 착지 후 다른 상태가 섞이는
// 회귀는 이 pin이 아니라 post-status.test.ts(파생 로직 자체)가 잡는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import ContentPostListPage from './page';

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
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts`) {
        if (!Array.isArray(drafts)) return { ok: false, status: drafts.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: drafts, error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

const DRAFT_A = {
  draft_id: 'd1', work_item_id: 'w1', slug: '2ho-blog', lang: 'ko', title: '2호 글',
  current_version: 2, latest_author_kind: 'human', updated_at: '2026-09-03T03:52:00+00:00',
};

describe('ContentPostListPage (story #3368)', () => {
  it('0건 — 빈 상태(EmptyState) 안내', async () => {
    stubFetch([]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.emptyTitle);
  });

  it('⭐목록 응답의 제목·버전·작성 주체·수정 시각이 화면에 그대로 나온다(AC1)', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain('2호 글');
    expect(container.textContent).toContain('v2');
    expect(container.textContent).toContain(koMessages.content.authorHuman);
  });

  it('⭐오늘 시점(게이트 신호 없음) — 모든 행이 "초안" 상태로 렌더된다', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusDraft);
    expect(container.textContent).not.toContain(koMessages.content.contentStatusPublished);
  });

  it('로드 실패 — 에러 안내(성공 목록으로 오인 표시하지 않는다)', async () => {
    stubFetch({ status: 500 });
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.loadFailed);
    expect(container.textContent).not.toContain(koMessages.content.emptyTitle);
  });

  it('작성 주체=agent 행은 "에이전트"로 표시된다', async () => {
    stubFetch([{ ...DRAFT_A, latest_author_kind: 'agent' }]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.authorAgent);
  });

  // story #3368 §6-3-1(유나 실측, 페드루 PO 확定) — origin_author_kind는 디디군 S2 PR
  // 도착 前엔 응답에 없다(옵셔널). 없는 것을 있는 것처럼 지어내면(예: latest_author_kind로
  // 대체) "에이전트가 쓰고 사람이 고침"과 "사람이 처음부터 씀"이 다시 구별 불가능해진다 —
  // fail-closed로 "—"만 보여야 한다.
  it('⭐origin_author_kind 필드가 아직 없음(S2 도착 前) — 원작성 주체 열에 "—"(fail-closed)', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    const originCell = container.querySelector('[data-testid="content-origin-author"]');
    expect(originCell?.textContent).toBe(koMessages.content.originAuthorUnknown);
  });

  it('⭐origin_author_kind=agent·latest_author_kind=human(에이전트가 쓰고 사람이 고친 글) — 두 열이 서로 다른 값을 보인다', async () => {
    stubFetch([{ ...DRAFT_A, origin_author_kind: 'agent', latest_author_kind: 'human' }]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    const originCell = container.querySelector('[data-testid="content-origin-author"]');
    expect(originCell?.textContent).toBe(koMessages.content.authorAgent);
    // 최종 수정 주체 칸(다음 형제 td)은 여전히 "휴먼" — 원작성과 최종수정이 갈리는 실제
    // 케이스가 목록에서 구별된다(§6-3-1이 고치려던 정확히 그 자리).
    expect(container.textContent).toContain(koMessages.content.authorHuman);
  });
});
