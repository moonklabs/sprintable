// @vitest-environment jsdom
//
// story #3368(Phase0·마케팅운영 S4) — 글 목록 화면(S1·S2 와이어프레임). organization/
// connectors/page.test.tsx와 동형 harness(useDashboardContext 목·NextIntlClientProvider·
// createRoot·stubFetch).
//
// story #3384(Phase0 결함, 유나 원인 진단·페드루 PO 확定 2026-09-03) — 목록이 게이트·발행
// 신호 없이 deriveContentPostStatus({})를 빈 입력으로 호출해 모든 행이 항상 '초안'으로만
// 뜨던 결함의 근본 수정. 게이트·발행 필드가 없는 행(신호 자체가 null)은 여전히 '초안'으로
// 정확히 떨어지고, 신호가 있는 행은 그 값을 그대로 반영한다 — 파생 로직 자체(다섯 상태
// 전부)의 세부 분기 회귀는 이 파일이 아니라 post-status.test.ts가 잡는다.
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
  body_sha256: 'h1', gate_status: null, reapproval_required: null, sealed_content_sha256: null,
  published_at: null,
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

  it('⭐게이트/발행 신호가 전부 null인 행 — "초안" 상태로 렌더된다', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('draft');
  });

  // 페드루 PO 리뷰(2026-09-03) — #3384 결함의 정반대 명제를 직접 pin한다: 신호가 있는
  // 행은 더는 '초안'으로 뭉개지지 않는다. 페이지 머리말 설명문에 "초안"이라는 단어가
  // 그대로 들어있어(t('description')) textContent 전역 부정 매칭은 오탐이다 — 칩
  // 엘리먼트의 data-status-chip 속성값으로만 정확히 판정한다.
  it('⭐gate_status=pending — "승인 대기" 상태로 렌더된다(AC — #3384 결함 회귀 방지)', async () => {
    stubFetch([{ ...DRAFT_A, gate_status: 'pending' }]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('pending');
  });

  it('⭐gate_status=approved + sealed_content_sha256===body_sha256 — "승인됨" 상태로 렌더된다', async () => {
    stubFetch([{ ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1' }]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('approved');
  });

  it('⭐published_at 있음 — "발행됨" 상태로 렌더된다', async () => {
    stubFetch([{
      ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
      published_at: '2026-09-03T18:44:00Z',
    }]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('published');
  });

  it('⭐gate_status=pending + reapproval_required=true — "재승인 필요" 상태로 렌더된다', async () => {
    stubFetch([{
      ...DRAFT_A, gate_status: 'pending', reapproval_required: true,
      sealed_content_sha256: 'h1', published_at: '2026-09-03T18:44:00Z',
    }]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('reapproval_needed');
  });

  // 페드루 PO 리뷰(2026-09-03) — `draft.published_at != null`은 값이 null이든 계약
  // 필드(gate_status·published_at) 자체가 응답에서 통째로 빠졌든 똑같이 false가 되어
  // "발행 안 됐다"로 단정한다(초안/승인됨 색 칩을 그린다). AC4는 그 경우 색 칩이 아니라
  // "—"여야 한다(§3-1-1 "모른다≠다르다") — `...DRAFT_A, gate_status: undefined}`처럼
  // 스프레드로 얹으면 JS 객체엔 키가 여전히 남아(값만 undefined) 이 결함을 재현하지
  // 못한다. 구조분해 할당으로 키 자체를 제거해야 실제 "계약 결손" 응답을 흉내낸다.
  it('⭐계약 필드(gate_status·published_at) 자체가 응답에 없음 — 색 있는 칩 0, "—"로 렌더된다(AC4)', async () => {
    const { gate_status: _gs, published_at: _pa, ...draftMissingContract } = DRAFT_A;
    stubFetch([draftMissingContract]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')).toBeNull();
    // origin_author_kind 열도 같은 문구("—")를 쓰므로(별개 fail-closed 축, 위 테스트
    // 참조) row 전체가 아니라 상태 칸(두 번째 td)으로 정확히 scope한다 — 아니면 그
    // 열의 기존 "—"에 편승한 공허통과가 된다.
    const statusCell = container.querySelectorAll('[data-testid="content-list-row"] td')[1];
    expect(statusCell?.textContent).toBe(koMessages.content.originAuthorUnknown);
  });

  // 카디르군 QA 뮤테이션(2026-09-03) — 위 테스트는 gate_status·published_at 키를 항상
  // 같이 빼서, published_at 판정 하나만 떼어내도(둘 다 없다는 결합 조건에 편승) 초록이
  // 나오는 공허통과 위험이 있었다. 두 축을 독립적으로 pin한다.
  it('⭐gate_status는 정상(approved+해시일치)인데 published_at 키만 없음 — "—"(AC4, published_at 축 단독)', async () => {
    const { published_at: _pa, ...draftApprovedNoPublishedAtKey } = {
      ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
    };
    stubFetch([draftApprovedNoPublishedAtKey]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')).toBeNull();
    const statusCell = container.querySelectorAll('[data-testid="content-list-row"] td')[1];
    expect(statusCell?.textContent).toBe(koMessages.content.originAuthorUnknown);
  });

  it('⭐published_at 키는 있음(null 포함)인데 gate_status 키만 없음 — "—"(AC4, gate_status 축 단독)', async () => {
    const { gate_status: _gs, ...draftNoGateStatusKey } = { ...DRAFT_A, published_at: null };
    stubFetch([draftNoGateStatusKey]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')).toBeNull();
    const statusCell = container.querySelectorAll('[data-testid="content-list-row"] td')[1];
    expect(statusCell?.textContent).toBe(koMessages.content.originAuthorUnknown);
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

  // 유나 라이브 검수(2026-09-03, head 6f575809b) — 실물이 평문 <td>텍스트</td>였다(칩 아님).
  // 시안 S1·스토리 AC1 본문("원작성 주체·최종 수정 주체를 확인할 수 있다")은 두 칩을
  // 명시한다 — 텍스트로는 목록을 훑을 때 "누가 썼나"가 눈에 안 걸린다.
  it('⭐원작성·최종수정 주체는 평문이 아니라 칩(배지)으로 렌더된다(§6-3-1 AC1 정정)', async () => {
    stubFetch([{ ...DRAFT_A, origin_author_kind: 'agent', latest_author_kind: 'human' }]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    const originCell = container.querySelector('[data-testid="content-origin-author"]');
    const latestCell = container.querySelector('[data-testid="content-latest-author"]');
    expect(originCell?.querySelector('.proof-surface')).not.toBeNull();
    expect(latestCell?.querySelector('.proof-surface')).not.toBeNull();
  });
});
