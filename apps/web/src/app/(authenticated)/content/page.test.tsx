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

// story #3744 — ⋯ 행 메뉴의 「승인 요청 보기」가 useRouter().push()로 이동한다(insights-
// board/page.test.tsx와 동형 mock 관례).
const { routerPushMock } = vi.hoisted(() => ({ routerPushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

import ContentPostListPage from './page';
import { ToastProvider, ToastContainer, useToast } from '@/components/ui/toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// story #3759 — ContentPostListPage는 정적 import(위)라 afterEach의 vi.resetModules()로
// 다시 뜨지 않는다 — 이 파일의 정적 ToastProvider와 같은 모듈 인스턴스를 계속 참조하므로
// (kanban-board.test.tsx류의 동적 재-import 처방 불요) 여기서 그냥 감싸면 된다.
function TestToastRenderer() {
  const { toasts, dismissToast } = useToast();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToastProvider>
        {node}
        <TestToastRenderer />
      </ToastProvider>
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

// story #3744 — 행 액션이 이제 ⋯ DropdownMenu 안에 있다(base-ui가 content를
// document.body에 portal — container 스코프 밖). n번째(0-based) 행의 트리거를 눌러
// 메뉴를 연다. dropdown-menu.test.tsx의 document.querySelector 관례와 동형.
async function openRowMenu(n = 0) {
  const triggers = container.querySelectorAll('[data-testid="content-row-actions-trigger"]');
  await act(async () => {
    (triggers[n] as HTMLElement).click();
  });
  await flush();
}

// story #3734(카디르 CI 적발·content-bff-route-coverage.guard.test.ts #3445) — 실
// 코드가 `?`를 항상 템플릿 «안»에 두도록 바뀌어(가드가 `?` 밖 보간을 못 읽어서) 기본
// 뷰(showArchived=false)도 이제 트레일링 빈 `?`를 붙여 부른다(`.../drafts?`) — 두
// stub 모두 트레일링 `?` 유무 둘 다 받아들이게 정규화한다.
function stripTrailingBareQuery(url: string): string {
  return url.endsWith('?') ? url.slice(0, -1) : url;
}

function stubFetch(drafts: unknown[] | { status: number }, meta: { totalCount: number | null } | null = null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = stripTrailingBareQuery(String(input));
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts`) {
        if (!Array.isArray(drafts)) return { ok: false, status: drafts.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: drafts, error: null, meta }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

// story #3734 — 실 BE 동작(목록 기본 제외·include_deleted=true 조회·archive/restore
// POST가 draft.is_deleted를 뒤집음)을 상태 머신으로 흉내내는 stub. 위 stubFetch(정적
// 목록 하나만)와 달리 토글·액션 클릭의 왕복(요청→상태 변화→재조회)까지 실제로 검증한다.
function stubFetchStateful(initial: Array<Record<string, unknown> & { draft_id: string; is_deleted?: boolean }>) {
  const state = new Map(initial.map((d) => [d.draft_id, { ...d }]));
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = String(input);
      calls.push(`${init?.method ?? 'GET'} ${rawUrl}`);
      const url = stripTrailingBareQuery(rawUrl);
      const listBase = `/api/organizations/${ORG_ID}/site-posts/drafts`;
      if (url === listBase || url === `${listBase}?include_deleted=true`) {
        const includeDeleted = url.includes('include_deleted=true');
        const rows = [...state.values()].filter((d) => includeDeleted || !d.is_deleted);
        return { ok: true, status: 200, json: async () => ({ data: rows, error: null, meta: null }) };
      }
      const actionMatch = /\/site-posts\/drafts\/([^/]+)\/(archive|restore)$/.exec(url);
      if (actionMatch && init?.method === 'POST') {
        const [, draftId, action] = actionMatch;
        const draft = state.get(draftId);
        if (!draft) return { ok: false, status: 404, json: async () => ({}) };
        draft.is_deleted = action === 'archive';
        return { ok: true, status: 200, json: async () => ({ data: { draft_id: draftId, is_deleted: draft.is_deleted }, error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
  return { state, calls };
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

  // story #3744 범위 ⑥ — X-Total-Count 기반 부분 상태 줄. 페드루 스티어(2026-09-09) —
  // board.tasksPartialCount(story-detail-panel.tsx 선례) 재사용, 새 키 발명 0.
  describe('부분 상태 줄(story #3744 ⑥)', () => {
    it('⭐total 있음 — board.tasksPartialCount 문구가 뜬다', async () => {
      stubFetch([DRAFT_A], { totalCount: 5 });
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      expect(container.querySelector('[data-testid="content-partial-state"]')?.textContent).toBe(
        koMessages.board.tasksPartialCount.replace('{total}', '5').replace('{loaded}', '1'),
      );
    });

    it('⭐total이 null(헤더 못 받음) — 부분 상태 줄 자체를 안 그린다(한 페이지를 전체로 위장 금지)', async () => {
      stubFetch([DRAFT_A], { totalCount: null });
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      expect(container.querySelector('[data-testid="content-partial-state"]')).toBeNull();
    });

    it('meta 자체가 없음(구 계약) — 부분 상태 줄을 안 그린다(뮤테이션 표적 — ?? null 가드)', async () => {
      stubFetch([DRAFT_A], null);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      expect(container.querySelector('[data-testid="content-partial-state"]')).toBeNull();
    });

    it('0건이면 total이 있어도 부분 상태 줄을 안 그린다(빈 상태와 안 겹침)', async () => {
      stubFetch([], { totalCount: 0 });
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      expect(container.querySelector('[data-testid="content-partial-state"]')).toBeNull();
    });

    // 유나 CHANGES(2026-09-09, PO 채택) — shownCount(=drafts.length, 필터 前)는 표가
    // 그리는 visibleRows(탭 필터 後)와 statusTab≠'all'일 때 어긋난다("18개 중 18개"
    // 거짓 문장). 탭 켜진 채로는 이 줄 자체를 안 그린다.
    it('⭐탭이 「전체」가 아니면(예: 초안) total이 있어도 부분 상태 줄을 안 그린다(뮤테이션 표적)', async () => {
      stubFetch([DRAFT_A], { totalCount: 5 });
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="content-partial-state"]')).not.toBeNull();

      const draftTab = [...container.querySelectorAll('[role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusDraft,
      ) as HTMLElement;
      await act(async () => { draftTab.click(); });
      await flush();

      expect(container.querySelector('[data-testid="content-partial-state"]')).toBeNull();
    });
  });

  // 유나 CHANGES(2026-09-09, PO 채택) — 최초 4탭(승인됨을 발행됨에 합침)은 그 탭 안의
  // 행(칩 「승인됨」)을 부정했다. 정본 = 5탭, 라벨은 contentStatus* 칩 키 재사용.
  describe('상태 탭 5개(story #3744, 유나 CHANGES)', () => {
    it('⭐탭 5개가 전체·초안·승인 대기·승인됨·발행됨 순서로, contentStatus* 라벨 그대로 뜬다', async () => {
      stubFetch([DRAFT_A]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const labels = [...container.querySelectorAll('[role="tab"]')].map((el) => el.textContent);
      expect(labels).toEqual([
        koMessages.content.statusTabAll,
        koMessages.content.contentStatusDraft,
        koMessages.content.contentStatusPending,
        koMessages.content.contentStatusApproved,
        koMessages.content.contentStatusPublished,
      ]);
    });

    it('⭐approved(미발행) 행은 「승인됨」 탭에 걸리고 「발행됨」 탭에는 안 걸린다(뮤테이션 표적 — 유나가 잡은 결함 그 자체)', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1' }]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const publishedTab = [...container.querySelectorAll('[role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusPublished,
      ) as HTMLElement;
      await act(async () => { publishedTab.click(); });
      await flush();
      expect(container.querySelector('[data-testid="content-list-row"]')).toBeNull();

      const approvedTab = [...container.querySelectorAll('[role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusApproved,
      ) as HTMLElement;
      await act(async () => { approvedTab.click(); });
      await flush();
      expect(container.querySelector('[data-testid="content-list-row"]')).not.toBeNull();
    });

    it('⭐탭이 「전체」가 아닌데 그 탭에 걸리는 행이 0이면 statusTabEmpty(설명·액션 없음)를 그린다', async () => {
      stubFetch([DRAFT_A]); // DRAFT_A는 초안 상태 — 발행됨 탭엔 안 걸림
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const publishedTab = [...container.querySelectorAll('[role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusPublished,
      ) as HTMLElement;
      await act(async () => { publishedTab.click(); });
      await flush();

      expect(container.textContent).toContain(koMessages.content.statusTabEmpty);
      // "전체" 탭의 emptyTitle/emptyDescription/대화 열기 액션은 이 갈래에서 안 뜬다.
      expect(container.textContent).not.toContain(koMessages.content.emptyDescription);
    });
  });

  it('⭐목록 응답의 제목·작성 주체·수정 시각이 화면에 그대로 나온다(AC1)', async () => {
    // 페드루 CHANGES Ⓒ(시안 v6) — 제목 밑 버전 부제는 걷었다(상세의 일). 이 테스트는
    // 그 목적을 유지하며 버전 단언만 뺀다.
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ContentPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain('2호 글');
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

  // story #3734 — 「보관」 행 액션·「보관됨 보기」 토글.
  describe('보관(story #3734)', () => {
    it('⭐can_archive=false — 「보관」 항목이 ⋯ 메뉴에 안 보인다(fail-closed, can_withdraw와 동형 정책)', async () => {
      stubFetch([{ ...DRAFT_A, can_archive: false }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      await openRowMenu();

      expect(document.querySelector('[data-testid="content-archive-action"]')).toBeNull();
    });

    it('⭐can_archive=true — ⋯ 메뉴의 「보관」 클릭 시 POST .../archive를 호출하고, 기본 목록(보관됨 숨김)에서 그 행이 즉시 사라진다', async () => {
      const { state, calls } = stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      await openRowMenu();

      expect(document.body.textContent).toContain(koMessages.content.archiveAction);
      const button = document.querySelector('[data-testid="content-archive-action"]') as HTMLElement;
      await act(async () => {
        button.click();
      });
      await flush();

      expect(calls).toContain(`POST /api/organizations/${ORG_ID}/site-posts/drafts/d1/archive`);
      expect(state.get('d1')?.is_deleted).toBe(true);
      expect(container.querySelector('[data-testid="content-list-row"]')).toBeNull();
      expect(container.textContent).toContain(koMessages.content.emptyTitle);
    });

    it('⭐「보관됨 보기」 토글 — include_deleted=true로 재조회해 보관된 행이 「보관됨」 배지·⋯ 메뉴에 「보관 해제」와 함께 보인다', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: true }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();

      // 기본 상태 — 보관된 행 제외이므로 빈 목록.
      expect(container.textContent).toContain(koMessages.content.emptyTitle);

      const toggle = container.querySelector('[data-testid="content-show-archived-toggle"]') as HTMLButtonElement;
      expect(toggle.textContent).toBe(koMessages.content.showArchivedToggle);
      await act(async () => {
        toggle.click();
      });
      await flush();

      expect(toggle.textContent).toBe(koMessages.content.hideArchivedToggle);
      expect(container.querySelector('[data-testid="content-archived-badge"]')?.textContent).toBe(
        koMessages.content.contentStatusArchived,
      );
      await openRowMenu();
      const restoreButton = document.querySelector('[data-testid="content-archive-action"]');
      expect(restoreButton?.textContent).toBe(koMessages.content.unarchiveAction);
    });

    it('⭐「보관됨 보기」에서 ⋯ 메뉴의 「보관 해제」 클릭 — POST .../restore 호출 후에도 그 행은 목록에 남고(include_deleted=true는 "포함"이지 "전용"이 아니다) 배지·메뉴 항목만 뒤집힌다', async () => {
      const { state, calls } = stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: true }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      const toggle = container.querySelector('[data-testid="content-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => {
        toggle.click();
      });
      await flush();
      await openRowMenu();

      const restoreButton = document.querySelector('[data-testid="content-archive-action"]') as HTMLElement;
      await act(async () => {
        restoreButton.click();
      });
      await flush();

      expect(calls).toContain(`POST /api/organizations/${ORG_ID}/site-posts/drafts/d1/restore`);
      expect(state.get('d1')?.is_deleted).toBe(false);
      expect(container.querySelector('[data-testid="content-list-row"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="content-archived-badge"]')).toBeNull();
      await openRowMenu();
      expect(document.querySelector('[data-testid="content-archive-action"]')?.textContent).toBe(
        koMessages.content.archiveAction,
      );
    });

    it('⭐「보관됨 보기」 뷰에서 아직 안 보관된 행을 ⋯ 메뉴에서 「보관」 클릭 — 행은 그대로 남고 배지·메뉴 항목이 「보관됨」/「보관 해제」로 뒤집힌다(include_deleted=true는 "포함", "전용" 아님 — 뮤테이션 표적)', async () => {
      const { state, calls } = stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      const toggle = container.querySelector('[data-testid="content-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => {
        toggle.click();
      });
      await flush();
      await openRowMenu();
      // 토글 전환 직후엔 미보관 행이라 「보관」 항목.
      expect(document.querySelector('[data-testid="content-archive-action"]')?.textContent).toBe(
        koMessages.content.archiveAction,
      );

      const archiveButton = document.querySelector('[data-testid="content-archive-action"]') as HTMLElement;
      await act(async () => {
        archiveButton.click();
      });
      await flush();

      expect(calls).toContain(`POST /api/organizations/${ORG_ID}/site-posts/drafts/d1/archive`);
      expect(state.get('d1')?.is_deleted).toBe(true);
      expect(container.querySelector('[data-testid="content-list-row"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="content-archived-badge"]')?.textContent).toBe(
        koMessages.content.contentStatusArchived,
      );
      await openRowMenu();
      expect(document.querySelector('[data-testid="content-archive-action"]')?.textContent).toBe(
        koMessages.content.unarchiveAction,
      );
    });

    it('⭐기본 뷰(보관됨 숨김)에서 ⋯ 메뉴의 「보관」 클릭 직후 로컬 낙관 갱신으로 행이 즉시 사라진다(재요청 없이)', async () => {
      const { calls } = stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      const callsAfterInitialLoad = calls.length;
      await openRowMenu();

      const button = document.querySelector('[data-testid="content-archive-action"]') as HTMLElement;
      await act(async () => {
        button.click();
      });
      await flush();

      expect(container.querySelector('[data-testid="content-list-row"]')).toBeNull();
      // 낙관 갱신 — archive POST 하나만 추가되고, 목록 GET이 다시 안 나간다.
      expect(calls.length).toBe(callsAfterInitialLoad + 1);
      expect(calls[calls.length - 1]).toBe(`POST /api/organizations/${ORG_ID}/site-posts/drafts/d1/archive`);
    });

    // 카디르 CI 적발(story #3734) — 정적 라벨(「보관」/「보관 해제」)이 행마다 똑같아
    // verify-no-new-repeated-row-action-names(§22-18) 위반. aria-label에 순번+라벨을
    // 품는 것으로 처방 — 여기서 그 값이 실제로 항목별로 갈리는지 직접 확認한다(가드
    // 자신은 "aria-label 있다/없다"만 보고 값의 «품음 여부»는 안 잰다는 것이 스크립트
    // 자체 ⚠️ 선언 — 이 assertion이 그 사각을 메운다).
    // story #3744 — aria-label은 이제 ⋯ 트리거(data-testid="content-row-actions-trigger")에
    // 있다(archive-action 자체는 메뉴 항목 텍스트, 접근 이름은 트리거가 갖는다).
    it('⭐⋯ 메뉴 트리거의 aria-label이 행 순번을 품어 두 행이 서로 다른 값을 갖는다(§22-18 처방 검증)', async () => {
      stubFetch([
        { ...DRAFT_A, draft_id: 'd1', can_archive: true },
        { ...DRAFT_A, draft_id: 'd2', can_archive: true },
      ]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();

      const triggers = container.querySelectorAll('[data-testid="content-row-actions-trigger"]');
      expect(triggers).toHaveLength(2);
      const labels = [...triggers].map((b) => b.getAttribute('aria-label'));
      expect(labels[0]).not.toBeNull();
      expect(labels[0]).not.toBe(labels[1]);
      expect(labels[0]).toContain('1');
      expect(labels[1]).toContain('2');
    });

    // 유나 CHANGES(story #3734, PR#4079 코멘트) — 보관 직후 행이 그냥 사라지면 「삭제」로
    // 읽힌다. 토스트(「보관했습니다」+「보관됨 보기」 액션)로 "어디로 갔는지"를 알린다.
    it('⭐⋯ 메뉴의 「보관」 클릭 — 「보관했습니다」 토스트가 뜨고, 그 액션 클릭 시 「보관됨 보기」로 전환된다', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      await openRowMenu();

      const button = document.querySelector('[data-testid="content-archive-action"]') as HTMLElement;
      await act(async () => {
        button.click();
      });
      await flush();

      expect(container.textContent).toContain(koMessages.content.archivedToast);
      const toastActionButtons = [...container.querySelectorAll('button')].filter(
        (b) => b.textContent === koMessages.content.showArchivedToggle,
      );
      // 헤더 토글(이미 「보관됨 보기」로 그려진 상태)과 토스트 액션 버튼 둘 다 같은 라벨을
      // 쓴다(유나 定 — 기존 토글 낱말 재사용) — 토스트 쪽을 눌러도 같은 효과인지 본다.
      expect(toastActionButtons.length).toBeGreaterThanOrEqual(1);
      const toggleBefore = container.querySelector('[data-testid="content-show-archived-toggle"]')?.textContent;
      expect(toggleBefore).toBe(koMessages.content.showArchivedToggle);

      const toastAction = toastActionButtons[toastActionButtons.length - 1];
      await act(async () => {
        toastAction.click();
      });
      await flush();

      expect(container.querySelector('[data-testid="content-show-archived-toggle"]')?.textContent).toBe(
        koMessages.content.hideArchivedToggle,
      );
    });

    it('⭐⋯ 메뉴에서 「보관 해제」(restore) 클릭 — 토스트가 안 뜬다(되돌리기 자체는 이미 보이는 화면 상태의 반전이라 "어디로 갔는지" 안내가 불필요)', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: true }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      const toggle = container.querySelector('[data-testid="content-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => {
        toggle.click();
      });
      await flush();
      await openRowMenu();

      const restoreButton = document.querySelector('[data-testid="content-archive-action"]') as HTMLElement;
      await act(async () => {
        restoreButton.click();
      });
      await flush();

      expect(container.textContent).not.toContain(koMessages.content.archivedToast);
    });

    // PO 추가(08:12Z) — 「보관됨 보기」가 이미 켜진 화면에서 보관하면 토스트는 뜨되
    // 액션은 없다(그 액션은 "지금 있는 곳으로 가라"가 돼 의미가 없다 — 뮤테이션 표적).
    it('⭐「보관됨 보기」가 이미 켜진 상태에서 ⋯ 메뉴의 「보관」 클릭 — 토스트는 뜨지만 액션 버튼은 없다(PO 추가 08:12Z)', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => {
        root.render(wrap(<ContentPostListPage />));
      });
      await flush();
      const toggle = container.querySelector('[data-testid="content-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => {
        toggle.click();
      });
      await flush();
      await openRowMenu();

      const archiveButton = document.querySelector('[data-testid="content-archive-action"]') as HTMLElement;
      await act(async () => {
        archiveButton.click();
      });
      await flush();

      expect(container.textContent).toContain(koMessages.content.archivedToast);
      // showArchived=true인 상태라 헤더 토글은 이미 hideArchivedToggle로 바뀌어 있다 —
      // showArchivedToggle 라벨을 가진 버튼이 전혀 없어야 한다(헤더에도 토스트에도 없음).
      const showArchivedLabelButtons = [...container.querySelectorAll('button')].filter(
        (b) => b.textContent === koMessages.content.showArchivedToggle,
      );
      expect(showArchivedLabelButtons.length).toBe(0);
    });
  });

  // story #3744(페드루 CHANGES Ⓐ, 시안 v6) — 상태 뒤 다음 발은 이제 ⋯ 메뉴 뒤에 숨지
  // 않고 행에 상시 보이는 outline 버튼이다("상태 딱지는 사람을 멈춰 세우고 다음 발은
  // 움직인다·숨긴 액션은 터치에선 없는 것"). ⋯ 메뉴엔 보관/보관 해제만 남는다.
  describe('상태 뒤 다음 발(story #3744, Ⓐ 시안 v6 — 행에 상시 노출)', () => {
    it('⭐승인 대기 행(gate_status=pending) — 「승인 요청 보기」 버튼이 행에 상시 보이고 클릭 시 /inbox?tab=gates로 이동한다', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'pending' }]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const button = [...container.querySelectorAll('button')].find(
        (el) => el.textContent === koMessages.content.approvalRequestViewCta,
      ) as HTMLElement;
      expect(button).toBeTruthy();
      await act(async () => { button.click(); });
      await flush();

      expect(routerPushMock).toHaveBeenCalledWith('/inbox?tab=gates');
    });

    it('초안 행(gate_status=null) — 「승인 요청 보기」 버튼이 없다', async () => {
      stubFetch([DRAFT_A]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const button = [...container.querySelectorAll('button')].find(
        (el) => el.textContent === koMessages.content.approvalRequestViewCta,
      );
      expect(button).toBeUndefined();
    });

    it('⭐발행됨 행(published_at 있음)+public_url 있음 — 「발행된 글 보기」 버튼이 행에 상시 보인다', async () => {
      stubFetch([{
        ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
        published_at: '2026-09-09T00:00:00Z', public_url: 'https://sprintable.ai/ko/blog/2ho-blog',
      }]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const button = [...container.querySelectorAll('button')].find(
        (el) => el.textContent === koMessages.content.publishViewLink,
      );
      expect(button).toBeTruthy();
    });

    // PO 明示(2026-09-09) — public_url이 없으면(미발행 또는 public_site_base_url
    // 미설정) 「—」가 아니라 버튼 자체를 안 그린다. 뮤테이션 표적 — public_url 가드를
    // 지우면 이 테스트가 실패해야 한다.
    it('발행됨 행이라도 public_url이 없으면 「발행된 글 보기」 버튼이 안 뜬다(뮤테이션 표적)', async () => {
      stubFetch([{
        ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
        published_at: '2026-09-09T00:00:00Z', public_url: null,
      }]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const button = [...container.querySelectorAll('button')].find(
        (el) => el.textContent === koMessages.content.publishViewLink,
      );
      expect(button).toBeUndefined();
    });

    // 뮤테이션 표적 — ⋯ 메뉴 안에 같은 라벨의 항목을 남겨 두면(중복) 이 테스트가 잡는다.
    it('⭐같은 동작을 ⋯ 메뉴에 중복해 두지 않는다 — 승인 대기 행의 ⋯ 메뉴엔 「승인 요청 보기」가 없다', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'pending', can_archive: true }]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();
      await openRowMenu();

      const menuItem = [...document.querySelectorAll('[role="menuitem"]')].find(
        (el) => el.textContent === koMessages.content.approvalRequestViewCta,
      );
      expect(menuItem).toBeUndefined();
      // 보관은 여전히 메뉴 안에 남아 있어야 한다(사라지면 다른 결함).
      expect(document.querySelector('[data-testid="content-archive-action"]')).not.toBeNull();
    });

    // §22-18 "유나의 자" — verify-no-new-repeated-row-action-names.ts가 aria-label
    // «존재»만 보고 값이 실제로 항목별로 갈리는지는 안 잰다(스크립트 자체 ⚠️ 선언). 이
    // assertion이 그 사각을 메운다(archive-action pin과 동형).
    it('⭐「승인 요청 보기」 버튼의 aria-label이 행 순번을 품어 두 행이 서로 다른 값을 갖는다(§22-18 처방 검증)', async () => {
      stubFetch([
        { ...DRAFT_A, draft_id: 'd1', gate_status: 'pending' },
        { ...DRAFT_A, draft_id: 'd2', gate_status: 'pending' },
      ]);
      await act(async () => { root.render(wrap(<ContentPostListPage />)); });
      await flush();

      const buttons = [...container.querySelectorAll('button')].filter(
        (el) => el.textContent === koMessages.content.approvalRequestViewCta,
      );
      expect(buttons).toHaveLength(2);
      const labels = buttons.map((b) => b.getAttribute('aria-label'));
      expect(labels[0]).not.toBeNull();
      expect(labels[0]).not.toBe(labels[1]);
      expect(labels[0]).toContain('1');
      expect(labels[1]).toContain('2');
    });
  });
});
