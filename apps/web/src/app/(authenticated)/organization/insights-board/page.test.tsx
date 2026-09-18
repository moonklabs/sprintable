// @vitest-environment jsdom
//
// story #3503(성과 보드 화면) — BE #3502 의존(PR 브리프 헤더 참고, 이 스토리 작성 시점
// origin/develop 미착지) — 이 테스트는 전부 fixture 기반(BE 실물 미검증, CI가 도는
// 유일한 축). channels/page.test.tsx·channel-posts/page.test.tsx와 동형 harness
// (useDashboardContext 목·NextIntlClientProvider·createRoot·stubFetch·flush).
//
// DropdownMenu(윈도우/상태/정렬) 상호작용은 pointerdown→mousedown→click 3연타로 연다 —
// dropdown-menu.test.tsx의 forced `open` prop 패턴과 달리 실제 트리거 클릭 경로를 쓴다
// (사전 스모크 테스트로 이 3연타가 Base UI 메뉴를 실제로 여는 것을 확인한 뒤 채택).
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
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  await act(async () => { root.render(wrap(<InsightsBoardPage />)); });
  await flush();
}

async function openMenuAndClick(triggerTestId: string, itemText: string) {
  const trigger = container.querySelector(`[data-testid="${triggerTestId}"]`) as HTMLElement;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === itemText) as HTMLElement;
  expect(item, `메뉴 항목 "${itemText}"을(를) 찾지 못함`).not.toBeUndefined();
  await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

// 3겹 null 축 — bucket 자체 null(A.d1) · captured+정상값(A.d7) · not-captured 상태(B.d1
// pending·B.d7 failed) · captured인데 대표 지표만 null(C.d1) · bucket null(C.d7).
const ROW_A = {
  publication_id: 'pub-a', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-a',
  title: '글 A', published_at: '2026-09-01T00:00:00Z', external_url: 'https://example.com/a', connection_id: 'conn-1',
  d1: null,
  d7: { status: 'captured', normalized: { impressions: 120, reach: null, views: 0, engagements: null, clicks: null, spend: null, conversions: null }, captured_at: '2026-09-08T00:00:00Z' },
};
const ROW_B = {
  publication_id: 'pub-b', kind: 'site_post', channel: 'hosted_site', work_item_id: 'wi-b',
  title: '글 B', published_at: '2026-08-30T00:00:00Z', external_url: null, connection_id: null,
  d1: { status: 'pending', normalized: null, captured_at: null },
  d7: { status: 'failed', normalized: null, captured_at: null },
};
const ROW_C = {
  publication_id: 'pub-c', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-c',
  title: '글 C', published_at: '2026-08-20T00:00:00Z', external_url: null, connection_id: 'conn-2',
  d1: { status: 'captured', normalized: { impressions: null, reach: null, views: null, engagements: null, clicks: null, spend: null, conversions: null }, captured_at: '2026-09-05T00:00:00Z' },
  d7: null,
};

function stubFetch(opts: {
  page1?: unknown[];
  page1HasMore?: boolean;
  page1NextCursor?: string | null;
  page2?: unknown[];
  followUp?: (init?: RequestInit) => { status: number; body: unknown };
  reconcile?: (init?: RequestInit) => { status: number; body: unknown };
  // story #3746(3734 §4-C) — 숨은 건수(초안 보관이 언어별 발행 행 여러 개를
  // 한꺼번에 숨긴 경우). include_deleted=true 뷰에선 null이 정직한 값이라
  // 그 URL일 땐 hiddenCount와 무관하게 항상 null을 낸다.
  hiddenCount?: number | null;
}) {
  const page1 = opts.page1 ?? [ROW_A, ROW_B, ROW_C];
  const page1HasMore = opts.page1HasMore ?? false;
  const page1NextCursor = opts.page1NextCursor ?? null;
  const page2 = opts.page2 ?? [];
  const hiddenCount = opts.hiddenCount ?? null;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('/follow-ups') && init?.method === 'POST') {
      const result = opts.followUp?.(init) ?? { status: 201, body: { story_id: 'story-1' } };
      const ok = result.status < 400;
      // BFF는 성공 시 apiSuccess로 { data, error, meta } 봉투를 씌우지만, 실패 시엔
      // FastAPI raw 에러 바디(`{detail: ...}`)를 그대로 pass-through한다(위 follow-ups/
      // route.ts 그대로) — 그래서 실패 케이스의 opts.followUp 반환 body는 이미 그 raw
      // 형상이어야 하고, 여기서 다시 감싸면 안 된다.
      return {
        ok, status: result.status,
        json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body),
      } as Response;
    }
    if (url.includes('/reconcile') && init?.method === 'POST') {
      const result = opts.reconcile?.(init) ?? {
        status: 201, body: { id: 'recon-1', publication_id: 'pub-a', snapshot_id: null, live_raw: {}, verdicts: { views: 'match' }, has_mismatch: false, created_at: '2026-09-07T00:00:00Z' },
      };
      const ok = result.status < 400;
      return {
        ok, status: result.status,
        json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body),
      } as Response;
    }
    if (url.includes('/insights-board/cost-summary')) {
      // story #3809(Phase3·3-7 PR 3) — 이 화면이 이제 OrgCostSummaryCard도 같이
      // 마운트해 org 비용 원장을 별도로 fetch한다. 이 파일의 관심사는 그 카드가
      // 아니라 기존 표(§행/필터/정렬 등)이므로, 카드는 항상 「승인된 광고 홍보
      // 0건」의 최소 응답으로 조용히 통과시킨다(카드 자체 회귀는
      // org-cost-summary-card.test.tsx 전담).
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
      const usingCursor = url.includes('cursor=');
      const includeDeleted = url.includes('include_deleted=true');
      const rows = usingCursor ? page2 : page1;
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            rows, has_more: usingCursor ? false : page1HasMore, next_cursor: usingCursor ? null : page1NextCursor,
            hidden_count: includeDeleted ? null : hiddenCount,
          },
          error: null, meta: null,
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ data: null, error: { code: 'NOT_FOUND' } }) } as Response;
  }));
  return calls;
}

describe('InsightsBoardPage — d1/d7 셀 3겹 null 축(story #3503)', () => {
  it('bucket 자체 null(미스케줄) · captured 정상값 · not-captured 상태 · captured인데 지표 null을 각각 올바르게 그린다', async () => {
    stubFetch({});
    await mount();

    const rows = [...container.querySelectorAll('[data-testid="insights-board-row"]')];
    expect(rows).toHaveLength(3);

    // Row A: d1=null(미스케줄) · d7=captured, 기본 지표(views)=0(정상 캡처값 — null 아님).
    expect(rows[0]?.querySelector('[data-testid="insights-board-cell-unscheduled"]')).not.toBeNull();
    const rowACells = rows[0]!.querySelectorAll('[data-testid="insights-board-cell-value"]');
    expect(rowACells[0]?.textContent).toBe('0');

    // Row B: d1=pending(상태만) · d7=failed(destructive 톤).
    // story #3746(유나 v5) — 셀 라벨은 이제 「아직」(insightStatusWaiting, pending·
    // in_progress 공용) — 대기 중」이 아니다(그 값은 필터 라벨로 이동).
    const rowBStatusCells = rows[1]!.querySelectorAll('[data-testid="insights-board-cell-status"]');
    expect(rowBStatusCells).toHaveLength(2);
    expect(rowBStatusCells[0]?.textContent).toBe(koMessages.content.insightStatusWaiting);
    expect(rowBStatusCells[1]?.textContent).toBe(koMessages.content.insightStatusFailed);
    expect(rowBStatusCells[1]?.className).toContain('text-destructive');
    expect(rowBStatusCells[0]?.className).not.toContain('text-destructive');

    // Row C: d1=captured인데 impressions만 null(대시+사유) · d7=null(미스케줄).
    expect(rows[2]!.querySelector('[data-testid="insights-board-cell-value-dash"]')).not.toBeNull();
    expect(rows[2]!.querySelector('[data-testid="insights-board-cell-unscheduled"]')).not.toBeNull();
  });

  it('로드 실패(422 INSIGHTS_BOARD_INVALID_WINDOW)면 알려진 코드의 사람 말 문구가 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 422,
      json: async () => ({ detail: { code: 'INSIGHTS_BOARD_INVALID_WINDOW', message: 'bogus window' } }),
    } as Response)));
    await mount();
    expect(container.textContent).toContain(koMessages.insightsBoard.errorInvalidWindow);
  });

  it('행이 0개면 빈 상태 문구가 뜬다', async () => {
    stubFetch({ page1: [] });
    await mount();
    expect(container.textContent).toContain(koMessages.insightsBoard.emptyTitle);
  });

  // story #3746(유나 픽셀 PASS 곁들임, 2026-09-09) — 「발행」 칸이 merge-base부터
  // 상대 시각(formatRelativeTime)이었다 — 「그저께」류가 서로 다른 날을 겹쳐 가리고
  // (정렬 축인데 눈으로 안 갈림)·d1/d7 앵커 기준인데 ±12h가 뭉개지고·7일 지나면
  // 절대 표기로 넘어가 30d/90d 기간에선 한 열에 표기가 섞였다. §11-2 정본 절대
  // 포맷(formatScheduledAt)으로 고정 — 이 화면의 다른 절대-시각 칸과 형이 맞는다.
  //
  // ROW_A~C는 고정 과거 날짜(2026-09-01 등)라 formatRelativeTime 자체가 이미
  // 7일 초과 분기에서 formatScheduledAt로 위임한다(§ 위 주석 그대로) — 그
  // 고정 픽스처로는 이 뮤테이션(포맷 함수를 되돌리는 것)이 안 걸린다. 이 테스트는
  // «지금부터 2일 전»을 매번 계산해 formatRelativeTime이 정말 쓰였다면 반드시
  // 상대 문구("2일 전"류)가 나올 자리를 만든다(뮤테이션 킬로 실제 확認 완료).
  it('⭐「발행」 칸이 §11-2 정본 절대 포맷(MM-DD HH:mm)이다 — 상대 시각(예: N일 전) 아님', async () => {
    const recentPublishedAt = new Date(Date.now() - 2 * 86400000).toISOString();
    stubFetch({ page1: [{ ...ROW_A, published_at: recentPublishedAt }] });
    await mount();

    const rows = [...container.querySelectorAll('[data-testid="insights-board-row"]')];
    const publishedCell = rows[0]!.querySelector('[data-testid="insights-board-published-at"]');
    expect(publishedCell?.textContent).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} /);
    expect(publishedCell?.textContent).not.toMatch(/전|그저께|어제|오늘/);
  });
});

describe('InsightsBoardPage — 쿼리 파라미터(story #3503)', () => {
  it('window은 사용자가 뭘 고르든(기본값 포함) 항상 fetch 쿼리에 명시적으로 실린다', async () => {
    const calls = stubFetch({});
    await mount();
    const firstCall = calls.find((c) => c.includes('/insights-board?'));
    expect(firstCall).toContain('window=7d');
  });

  it('채널 필터 입력이 router.replace로 올바른 쿼리를 조립한다', async () => {
    stubFetch({});
    await mount();
    const input = container.querySelector('[data-testid="insights-board-channel-filter"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'threads');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(routerReplaceMock).toHaveBeenCalled();
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('channel=threads');
  });

  it('상태 필터 드롭다운에서 항목을 고르면 router.replace 쿼리에 status가 실린다', async () => {
    stubFetch({});
    await mount();
    await openMenuAndClick('insights-board-status-trigger', koMessages.content.insightStatusFailed);
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('status=failed');
  });

  // story #3746(유나 v5)·#3808(Phase3·3-3 PR4, 페드루 PO CHANGES 2026-09-12) —
  // 출처는 InsightSnapshot.status(BE)다, FE가 지어내는 옵션이 아니다. 통 다섯:
  // 수집 대기(pending+in_progress)·수집됨·채널 미제공·실패·건너뜀(#3808, X 종량
  // read 상한 도달). superseded는 옵션이 아니고(BE 기본 배제), dead_letter도
  // 옵션이 아니다(유령, BE 서비스 전수 0건).
  describe('InsightsBoardPage — 수집 상태 필터 통 다섯(story #3746·#3808)', () => {
    it('⭐뮤테이션 표적 — dead_letter는 필터 옵션 목록에 없다(전체 상태 메뉴 항목 전수)', async () => {
      stubFetch({});
      await mount();
      const trigger = container.querySelector('[data-testid="insights-board-status-trigger"]') as HTMLElement;
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
      // 「전체 상태」+통 다섯 = 정확히 6개(여섯 번째가 몰래 늘면(예: dead_letter 부활) 이 길이 자체가 어긋난다).
      expect(items).toHaveLength(6);
      expect(items).not.toContain('자동 재시도 멈춤');
      // PO CHANGES②(2026-09-09) — 드롭다운은 선택지 자리(명사구)라 상세 블록 전용
      // 문장(insightSnapshotUnsupported)이 아니라 셀과 같은 명사구(insightStatusUnsupported)
      // 를 쓴다(한 통 한 낱말).
      expect(items).toEqual([
        koMessages.insightsBoard.statusFilterAll,
        koMessages.insightsBoard.statusFilterPending,
        koMessages.content.insightStatusCaptured,
        koMessages.content.insightStatusUnsupported,
        koMessages.content.insightStatusFailed,
        koMessages.content.insightStatusSkipped,
      ]);
    });

    it('⭐「수집 대기」를 고르면(pending+in_progress 한 통) router.replace 쿼리엔 status=pending이 실린다(값 두 벌 아님)', async () => {
      stubFetch({});
      await mount();
      await openMenuAndClick('insights-board-status-trigger', koMessages.insightsBoard.statusFilterPending);
      const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
      expect(lastUrl).toContain('status=pending');
      expect(lastUrl).not.toContain('in_progress');
    });

    it('트리거에 status=pending이 URL에 실려 있으면 「수집 대기」 라벨을 보인다(content.insightStatusPending의 「대기 중」이 아니다)', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams('status=pending'));
      stubFetch({});
      await mount();
      const trigger = container.querySelector('[data-testid="insights-board-status-trigger"]');
      expect(trigger?.textContent).toBe(koMessages.insightsBoard.statusFilterPending);
      expect(trigger?.textContent).not.toBe(koMessages.content.insightStatusPending);
    });
  });

  it('정렬 드롭다운에서 항목을 고르면 router.replace 쿼리에 sort 역할(role)이 실린다 — 지표는 URL엔 별도, 실제 fetch에서 합성된다', async () => {
    stubFetch({});
    await mount();
    await openMenuAndClick('insights-board-sort-trigger', koMessages.insightsBoard.sortD1.replace('{metric}', koMessages.content.insightMetricViews));
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('sort=d1');
    expect(lastUrl).not.toContain('sort=views_d1');
  });

  it('PO REQUEST(2026-09-05) — 지표 선택기에서 항목을 고르면 metric 쿼리가 갈아끼워지고, sort=d1 역할과 합성돼 fetch에 실린다', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('sort=d1'));
    const calls = stubFetch({});
    await mount();
    await openMenuAndClick('insights-board-metric-trigger', koMessages.content.insightMetricSpend);
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('metric=spend');
    // URL이 바뀌면 useSearchParams도 갱신됐다고 가정하고 재장착해 fetch까지 확認.
    useSearchParamsMock.mockReturnValue(new URLSearchParams('sort=d1&metric=spend'));
    await act(async () => { root.render(wrap(<InsightsBoardPage />)); });
    await flush();
    const laterCall = calls.find((c) => c.includes('sort=spend_d1'));
    expect(laterCall).not.toBeUndefined();
  });

  // story #3583(페드루 PO 確定 2026-09-06) — GA4 유입 지표 2개가 선택기에 더해졌다
  // (열 추가가 아니라 이 선택기의 지표 축 확장 — DEFAULT_METRIC은 그대로 views).
  it('⭐지표 선택기에 유입 세션·유입 사용자가 있고, 고르면 metric 쿼리가 갈아끼워진다', async () => {
    stubFetch({});
    await mount();
    await openMenuAndClick('insights-board-metric-trigger', koMessages.content.insightMetricInflowSessions);
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('metric=inflow_sessions');
  });

  it('필터/정렬/방향이 이미 걸린 URL로 진입하면 그 값 그대로(+window 항상 포함) fetch 쿼리에 실린다', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('channel=threads&status=failed&sort=d7&metric=clicks&sort_dir=asc&window=30d'));
    const calls = stubFetch({});
    await mount();
    const firstCall = calls.find((c) => c.includes('/insights-board?'));
    expect(firstCall).toContain('window=30d');
    expect(firstCall).toContain('channel=threads');
    expect(firstCall).toContain('status=failed');
    expect(firstCall).toContain('sort=clicks_d7');
    expect(firstCall).toContain('sort_dir=asc');
  });
});

// story #3746(3734 AC3 잔존 A) — 목록 두 화면(content/page.tsx·channel-posts/
// page.tsx)과 같은 낱말·같은 파라미터명(showArchivedToggle/hideArchivedToggle·
// include_deleted=true).
describe('InsightsBoardPage — 보관됨 보기 토글·숨은 건수(story #3746)', () => {
  it('⭐토글이 꺼진 기본 상태 — fetch 쿼리에 include_deleted가 안 실린다', async () => {
    const calls = stubFetch({});
    await mount();
    const firstCall = calls.find((c) => c.includes('/insights-board?'));
    expect(firstCall).not.toContain('include_deleted');
  });

  it('⭐토글을 켜면(「보관됨 보기」 클릭) 라벨이 「보관됨 숨기기」로 바뀌고 include_deleted=true가 fetch 쿼리에 실린다', async () => {
    const calls = stubFetch({});
    await mount();
    const toggle = container.querySelector('[data-testid="insights-board-show-archived-toggle"]') as HTMLElement;
    expect(toggle.textContent).toBe(koMessages.content.showArchivedToggle);
    await act(async () => { toggle.click(); });
    await flush();
    expect(toggle.textContent).toBe(koMessages.content.hideArchivedToggle);
    const lastCall = calls.filter((c) => c.includes('/insights-board')).at(-1);
    expect(lastCall).toContain('include_deleted=true');
  });

  it('⭐숨은 건수가 있으면(기본 뷰) 「N건 숨김」이 뜬다 — 셀 수 있을 때만', async () => {
    stubFetch({ hiddenCount: 3 });
    await mount();
    expect(container.querySelector('[data-testid="insights-board-hidden-count"]')?.textContent)
      .toBe(koMessages.insightsBoard.archivedHiddenCount.replace('{count}', '3'));
  });

  it('숨은 건수가 0이거나 모르면(null) 「N건 숨김」을 안 그린다(지어내지 않는다)', async () => {
    stubFetch({ hiddenCount: 0 });
    await mount();
    expect(container.querySelector('[data-testid="insights-board-hidden-count"]')).toBeNull();
  });

  it('⭐보관됨 보기를 켠 뷰에선 숨은 건수 줄 자체를 안 그린다(그 뷰에선 무의미)', async () => {
    stubFetch({ hiddenCount: 3 });
    await mount();
    const toggle = container.querySelector('[data-testid="insights-board-show-archived-toggle"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    await flush();
    expect(container.querySelector('[data-testid="insights-board-hidden-count"]')).toBeNull();
  });

  // 페드루/유나 定 — 「선택한 조건에 해당하는 발행 글이 아직 없습니다」는 사용자가
  // 조건을 고른 적 없을 때(필터 0·보관됨 보기 꺼짐인데 빈 화면) 틀린 말이다.
  it('⭐필터 0인데 빈 화면 + 숨은 건수 > 0 — 「조건」 문구가 아니라 보관 때문임을 말하는 문구가 뜬다', async () => {
    stubFetch({ page1: [], hiddenCount: 5 });
    await mount();
    expect(container.textContent).toContain(koMessages.insightsBoard.archivedEmptyReason);
    expect(container.textContent).not.toContain(koMessages.insightsBoard.emptyDescription);
  });

  it('필터 0인데 빈 화면 + 숨은 건수 0(진짜 아무것도 없음) — 원래 빈 상태 문구 그대로', async () => {
    stubFetch({ page1: [], hiddenCount: 0 });
    await mount();
    expect(container.textContent).toContain(koMessages.insightsBoard.emptyDescription);
    expect(container.textContent).not.toContain(koMessages.insightsBoard.archivedEmptyReason);
  });
});

describe('InsightsBoardPage — 더 보기 누적(story #3503)', () => {
  it('has_more면 더 보기 버튼이 뜨고, 누르면 새 행이 «교체»가 아니라 «추가»된다', async () => {
    stubFetch({ page1: [ROW_A], page1HasMore: true, page1NextCursor: 'cursor-1', page2: [ROW_B] });
    await mount();
    expect(container.querySelectorAll('[data-testid="insights-board-row"]')).toHaveLength(1);

    const loadMoreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.insightsBoard.loadMore) as HTMLButtonElement;
    expect(loadMoreBtn).not.toBeUndefined();
    await act(async () => { loadMoreBtn.click(); });
    await flush();

    const rows = container.querySelectorAll('[data-testid="insights-board-row"]');
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain('글 A');
    expect(container.textContent).toContain('글 B');
  });
});

describe('InsightsBoardPage — 후속 조치 다이얼로그(story #3503)', () => {
  it('에이전트 액터에게는 후속 조치 버튼 자체가 안 보인다', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, currentMemberType: 'agent' });
    stubFetch({});
    await mount();
    expect(container.querySelector('[data-testid="insights-board-follow-up-button"]')).toBeNull();
  });

  it('doc a0da40c9 §21-5(유나 2026-09-05) — 제목 입력이 「[유형] {원문 제목}」으로 미리 채워지고, 유형을 바꾸면 갈아끼워진다', async () => {
    stubFetch({});
    await mount();
    const btn = container.querySelector('[data-testid="insights-board-follow-up-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();

    const titleInput = document.getElementById('follow-up-title') as HTMLInputElement;
    expect(titleInput.value).toBe(`[${koMessages.insightsBoard.followUpKindRepublish}] ${ROW_A.title}`);

    const editBtn = document.querySelector('[data-testid="follow-up-kind-edit"]') as HTMLButtonElement;
    await act(async () => { editBtn.click(); });
    expect(titleInput.value).toBe(`[${koMessages.insightsBoard.followUpKindEdit}] ${ROW_A.title}`);
  });

  it('PO REQUEST(2026-09-05, PR#3853 재리뷰) — 사람이 직접 고친 제목은 유형을 바꿔도 소리 없이 안 지워진다', async () => {
    stubFetch({});
    await mount();
    const btn = container.querySelector('[data-testid="insights-board-follow-up-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();

    const titleInput = document.getElementById('follow-up-title') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(titleInput, '내가 직접 쓴 제목');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(titleInput.value).toBe('내가 직접 쓴 제목');

    const editBtn = document.querySelector('[data-testid="follow-up-kind-edit"]') as HTMLButtonElement;
    await act(async () => { editBtn.click(); });
    // 유형은 바뀌었지만(버튼 aria-pressed로 확認) 손으로 쓴 제목은 그대로다.
    expect(editBtn.getAttribute('aria-pressed')).toBe('true');
    expect(titleInput.value).toBe('내가 직접 쓴 제목');
  });

  it('⭐성공 경로 — 만들면 story_id로 /board?story= 링크가 뜬다(getEntityHref 재사용)', async () => {
    stubFetch({ followUp: () => ({ status: 201, body: { story_id: 'story-99' } }) });
    await mount();
    const btn = container.querySelector('[data-testid="insights-board-follow-up-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();

    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === koMessages.insightsBoard.followUpSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    const link = document.querySelector('[data-testid="follow-up-success-link"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/board?story=story-99');
  });

  it('403 FOLLOW_UP_CREATE_HUMAN_ONLY — 알려진 코드의 사람 말 문구가 뜬다', async () => {
    stubFetch({ followUp: () => ({ status: 403, body: { detail: { code: 'FOLLOW_UP_CREATE_HUMAN_ONLY', message: 'human only' } } }) });
    await mount();
    const btn = container.querySelector('[data-testid="insights-board-follow-up-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === koMessages.insightsBoard.followUpSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();
    expect(document.querySelector('[data-testid="follow-up-error"]')?.textContent).toBe(koMessages.insightsBoard.errorFollowUpHumanOnly);
  });

  it('404 publication 없음(플레인 문자열 detail) — 서버 원문이 그대로 뜬다(지어내지 않는다)', async () => {
    stubFetch({ followUp: () => ({ status: 404, body: { detail: 'publication을 찾을 수 없습니다: pub-404' } }) });
    await mount();
    const btn = container.querySelector('[data-testid="insights-board-follow-up-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === koMessages.insightsBoard.followUpSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();
    expect(document.querySelector('[data-testid="follow-up-error"]')?.textContent).toBe('publication을 찾을 수 없습니다: pub-404');
  });

  it('422 FOLLOW_UP_INVALID_KIND — 알려진 코드의 사람 말 문구가 뜬다', async () => {
    stubFetch({ followUp: () => ({ status: 422, body: { detail: { code: 'FOLLOW_UP_INVALID_KIND', message: 'bad kind' } } }) });
    await mount();
    const btn = container.querySelector('[data-testid="insights-board-follow-up-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === koMessages.insightsBoard.followUpSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();
    expect(document.querySelector('[data-testid="follow-up-error"]')?.textContent).toBe(koMessages.insightsBoard.errorFollowUpInvalidKind);
  });
});

// story #3517(BE #3867 조각② REQUIRED, 유나 §13·§22-11 최종, PO 確定 2026-09-05) —
// 댓글 칸 네 갈래. comments_supported·comments_last_collected_at 신호로 "미수집"·
// "수집됐는데 0건"·"채널 미제공"·"해당 없음"이 갈린다(InsightsBoardMetricCell과
// 같은 "네 갈래를 하나도 안 숨긴다" 관례).
describe('InsightsBoardPage — 댓글 칸 네 갈래(story #3517)', () => {
  it('① site_post 행 — "해당 없음"(댓글 축 자체가 없다)', async () => {
    stubFetch({ page1: [{ ...ROW_B, comments_supported: false, comments_last_collected_at: null, comments_count: null, channel_post_draft_id: null }] });
    await mount();
    expect(container.querySelector('[data-testid="insights-board-comments-not-applicable"]')?.textContent).toBe('해당 없음');
  });

  // story #3517 조각②-b(페드루 PO 지적, 유나 프로브 오계수 2026-09-06) — ①②가 같은
  // testid를 써 실픽셀 프로브가 한 갈래로 세었다. testid도 갈래별로 갈린다.
  it('② channel_publication인데 채널이 댓글 수집 미지원 — "채널 미제공"(①과 다른 문구·다른 testid)', async () => {
    stubFetch({ page1: [{ ...ROW_A, comments_supported: false, comments_last_collected_at: null, comments_count: null, channel_post_draft_id: null }] });
    await mount();
    expect(container.querySelector('[data-testid="insights-board-comments-not-applicable"]')).toBeNull();
    expect(container.querySelector('[data-testid="insights-board-comments-channel-unsupported"]')?.textContent).toBe('채널 미제공');
  });

  it('③ comments_supported=true인데 last_collected_at=null — "아직 수집 전"(0건과 다른 문구)', async () => {
    stubFetch({ page1: [{ ...ROW_A, comments_supported: true, comments_last_collected_at: null, comments_count: null, channel_post_draft_id: null }] });
    await mount();
    expect(container.querySelector('[data-testid="insights-board-comments-uncollected"]')?.textContent).toBe('아직 수집 전');
  });

  it('④-a 수집됨·0건 — 이제 "댓글 0"으로 적는다(미수집과 신호로 갈렸으므로 §22-7 원칙이 선다)', async () => {
    stubFetch({ page1: [{ ...ROW_A, comments_supported: true, comments_last_collected_at: '2026-09-05T10:00:00Z', comments_count: 0, channel_post_draft_id: null }] });
    await mount();
    expect(container.querySelector('[data-testid="insights-board-comments-text"]')?.textContent).toBe('댓글 0');
  });

  it('④-b 수집됨·n건·draft_id 있음 — /content/channel-posts/{draft_id} 링크', async () => {
    stubFetch({ page1: [{ ...ROW_A, comments_supported: true, comments_last_collected_at: '2026-09-05T10:00:00Z', comments_count: 5, channel_post_draft_id: 'draft-42' }] });
    await mount();
    const link = container.querySelector('[data-testid="insights-board-comments-link"]') as HTMLAnchorElement;
    expect(link?.textContent).toBe('댓글 5');
    expect(link?.getAttribute('href')).toBe('/content/channel-posts/draft-42');
  });

  it('④-c 수집됨·n건·draft_id 없음(BE 예외 케이스) — 링크 없이 수만', async () => {
    stubFetch({ page1: [{ ...ROW_A, comments_supported: true, comments_last_collected_at: '2026-09-05T10:00:00Z', comments_count: 5, channel_post_draft_id: null }] });
    await mount();
    expect(container.querySelector('[data-testid="insights-board-comments-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="insights-board-comments-text"]')?.textContent).toBe('댓글 5');
  });
});

// story #3617(유나 3600 AC2 기준선) — 채널 포스트 화면 「성과 보기」에서 ?highlight=
// {publication_id}로 들어오면 해당 행을 강조·스크롤한다.
describe('InsightsBoardPage — ?highlight로 들어온 행 강조(story #3617)', () => {
  it('?highlight=pub-b — 그 행에 scrollIntoView가 불리고 강조 클래스가 붙는다', async () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    useSearchParamsMock.mockReturnValue(new URLSearchParams('highlight=pub-b'));
    stubFetch({});
    await mount();

    const rows = container.querySelectorAll('[data-testid="insights-board-row"]');
    const highlighted = [...rows].find((r) => r.getAttribute('data-highlighted') === 'true');
    expect(highlighted).not.toBeUndefined();
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('?highlight 없음 — 아무 행도 강조되지 않는다(보드 최상단으로 끝나는 기본 경로)', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams());
    stubFetch({});
    await mount();
    const rows = container.querySelectorAll('[data-testid="insights-board-row"]');
    expect([...rows].some((r) => r.getAttribute('data-highlighted') === 'true')).toBe(false);
  });

  it('?highlight가 존재하지 않는 publication_id를 가리키면(레이스·오타) 조용히 무시한다', async () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    useSearchParamsMock.mockReturnValue(new URLSearchParams('highlight=pub-does-not-exist'));
    stubFetch({});
    await mount();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});

// story #3620 AC3 — 행 액션 「원본과 대조」(발행 後 행에만·진행 中 비활성·결과는
// 행 아래 한 줄).
describe('InsightsBoardPage — 원본과 대조 행 액션(story #3620)', () => {
  it('channel_publication 행(A·C)에만 버튼이 있고, site_post 행(B)엔 없다', async () => {
    stubFetch({});
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="insights-board-row"]')];
    expect(rows[0]!.querySelector('[data-testid="insights-board-reconcile-button"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="insights-board-reconcile-button"]')).toBeNull();
    expect(rows[2]!.querySelector('[data-testid="insights-board-reconcile-button"]')).not.toBeNull();
  });

  it('누르면 진행 中 비활성 상태를 거쳐 결과가 행 아래 한 줄로 뜬다(지표별 일치/불일치/미측정)', async () => {
    stubFetch({
      reconcile: () => ({
        status: 201,
        body: {
          id: 'recon-1', publication_id: 'pub-a', snapshot_id: 'snap-1', live_raw: {},
          verdicts: { views: 'mismatch', engagements: 'match', impressions: 'unmeasured' },
          has_mismatch: true, created_at: '2026-09-07T00:00:00Z',
        },
      }),
    });
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="insights-board-row"]')];
    const btn = rows[0]!.querySelector('[data-testid="insights-board-reconcile-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await act(async () => { btn.click(); });
    await flush();

    const resultLine = container.querySelector('[data-testid="reconcile-result-line"]');
    expect(resultLine).not.toBeNull();
    expect(resultLine!.textContent).toContain(koMessages.insightsBoard.reconcileVerdictMismatch);
    expect(resultLine!.textContent).toContain(koMessages.insightsBoard.reconcileVerdictMatch);
    expect(resultLine!.textContent).toContain(koMessages.insightsBoard.reconcileVerdictUnmeasured);
  });

  it('409 CHANNEL_CONNECTION_NOT_ACTIVE — content 네임스페이스 기존 키(신규 키 0)의 문구가 행 아래에 뜬다', async () => {
    // story #3620 CHANGES(카디르 발견) — 새 키를 만들지 않고 content.errorChannelConnectionNotActive
    // (「연결 화면에서 확인」 안내까지 포함된 정본)를 재사용한다.
    stubFetch({
      reconcile: () => ({ status: 409, body: { detail: { code: 'CHANNEL_CONNECTION_NOT_ACTIVE', message: 'raw' } } }),
    });
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="insights-board-row"]')];
    const btn = rows[0]!.querySelector('[data-testid="insights-board-reconcile-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();

    expect(container.querySelector('[data-testid="insights-board-reconcile-error"]')?.textContent).toBe(
      koMessages.content.errorChannelConnectionNotActive,
    );
  });
});

// story #3766(별건 ⑩, 3746 §3 유나 定) — 「사람 차례」 발행 명령 축은 필터가 아니라
// 행 배지(FailureActionBadge, compact)로만 선다. 자리는 유나 정(issuecomment
// 2026-09-10 02:11Z 갈음): 행동칸(후속 조치·원본과 대조 버튼) «위» 별도 줄, 배지
// 없으면 그 줄 노드 자체가 없고(①), 버튼 div도 canCreateFollowUp||canReconcile일
// 때만 렌더한다(②).
describe('InsightsBoardPage — 「사람 차례」 행 배지(story #3766)', () => {
  const ROW_DEAD_LETTER = {
    publication_id: 'pub-dl', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-dl',
    title: '글 DL', published_at: '2026-09-01T00:00:00Z', external_url: null, connection_id: 'conn-1',
    d1: null, d7: null, command_status: 'dead_letter',
  };
  const ROW_BLOCKED = {
    publication_id: 'pub-bl', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-bl',
    title: '글 BL', published_at: '2026-09-01T00:00:00Z', external_url: null, connection_id: 'conn-2',
    d1: null, d7: null, command_status: 'blocked',
  };
  // 뮤테이션 대조 — dead_letter/blocked가 아닌 다른 command_status는(자동으로 풀리는
  // 갈래거나 이 화면엔 안 실리는 failure_kind가 필요한 갈래라) 배지가 안 떠야 한다.
  const ROW_PENDING = {
    publication_id: 'pub-pd', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-pd',
    title: '글 PD', published_at: '2026-09-01T00:00:00Z', external_url: null, connection_id: 'conn-3',
    d1: null, d7: null, command_status: 'pending',
  };
  const ROW_VOIDED = {
    publication_id: 'pub-vd', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-vd',
    title: '글 VD', published_at: '2026-09-01T00:00:00Z', external_url: null, connection_id: 'conn-4',
    d1: null, d7: null, command_status: 'voided',
  };

  it('⭐dead_letter 행엔 배지("발행 실패" 계열 문구)가 뜬다', async () => {
    stubFetch({ page1: [ROW_DEAD_LETTER] });
    await mount();
    const row = container.querySelector('[data-testid="insights-board-row"]')!;
    const badge = row.querySelector('[data-testid="channel-post-failure-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe(koMessages.content.channelPostsFailureDeadLetter);
  });

  it('⭐blocked 행엔 배지가 뜬다', async () => {
    stubFetch({ page1: [ROW_BLOCKED] });
    await mount();
    const row = container.querySelector('[data-testid="insights-board-row"]')!;
    const badge = row.querySelector('[data-testid="channel-post-failure-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe(koMessages.content.channelPostsFailureBlocked);
  });

  // 뮤테이션 대조 — BE 필드(command_status)가 응답에서 빠지면(undefined) 배지도 0.
  it('뮤테이션 대조 — command_status 자체가 없으면(BE 필드 누락 시뮬) 배지가 안 뜬다', async () => {
    const { command_status: _omit, ...rowWithoutField } = ROW_DEAD_LETTER;
    void _omit;
    stubFetch({ page1: [rowWithoutField] });
    await mount();
    const row = container.querySelector('[data-testid="insights-board-row"]')!;
    expect(row.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
  });

  it('pending·voided는 배지가 안 뜬다(이 보드엔 failure_kind/reasonCode가 없어 그 갈래는 애초에 판정 불가)', async () => {
    stubFetch({ page1: [ROW_PENDING, ROW_VOIDED] });
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="insights-board-row"]')];
    expect(rows[0]!.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
    expect(rows[1]!.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
  });

  it('배지가 뜬 행에서도 행동 버튼(후속 조치·원본과 대조)은 그대로 같이 선다(자리만 갈림, 행동 자체는 무변)', async () => {
    stubFetch({ page1: [ROW_DEAD_LETTER] });
    await mount();
    const row = container.querySelector('[data-testid="insights-board-row"]')!;
    expect(row.querySelector('[data-testid="insights-board-reconcile-button"]')).not.toBeNull();
  });

  // ①② — 배지도 버튼도 없을 때 그 자리 자체가 남지 않는다(빈 flex div가 gap만
  // 먹는 회귀 방지). site_post 행(canReconcile=false)이면서 command_status가 없는
  // 행으로 재는다 — canCreateFollowUp은 useDashboardContext mock의
  // currentMemberType='human'이라 기본 true인 만큼, agent로 바꿔 버튼 축까지 끈다.
  it('①② 배지도 행동 버튼도 없으면 그 td가 완전히 빈다(빈 wrapper 노드 0)', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, currentMemberType: 'agent' });
    const rowNoActionsNoBadge = {
      publication_id: 'pub-none', kind: 'site_post', channel: 'hosted_site', work_item_id: 'wi-none',
      title: '글 없음', published_at: '2026-09-01T00:00:00Z', external_url: null, connection_id: null,
      d1: null, d7: null, command_status: null,
    };
    stubFetch({ page1: [rowNoActionsNoBadge] });
    await mount();
    const row = container.querySelector('[data-testid="insights-board-row"]')!;
    // story #3806(PR5 조각⑥) — 광고비 칸이 comments 뒤·actions 앞에 신설돼 actions는
    // 이제 8번째(index 7) 열이다(제목·채널·발행·d1·d7·댓글·광고비·행동).
    const actionCell = row.querySelectorAll('td')[7] as HTMLElement;
    expect(actionCell.children.length).toBe(0);
  });
});

// story #3656(Phase2·FE+BE, 페드루 PO 確定 2026-09-07) — 소재/훅 묶음 토글. BE(#3656
// 절반)가 아직 안 착지해 asset_sha256s/hook_key가 실린 목 행으로 먼저 짓는다(PO
// 지시 — FE 절반 지금, BE는 #4002 착지 뒤 같은 브랜치에).
const GROUPABLE_ROW_IG = {
  publication_id: 'pub-ig', kind: 'channel_publication', channel: 'instagram', work_item_id: 'wi-ig',
  title: '캐러셀 IG', published_at: '2026-09-05T00:00:00Z', external_url: null, connection_id: 'conn-1',
  d1: { status: 'captured', normalized: { impressions: 100, reach: null, views: null, engagements: null, clicks: null, spend: null, conversions: null, inflow_sessions: null, inflow_users: null }, captured_at: '2026-09-06T00:00:00Z' },
  d7: null,
  asset_sha256s: ['abcdefabcdef1111'], hook_key: 'hook-A',
};
const GROUPABLE_ROW_FB = {
  publication_id: 'pub-fb', kind: 'channel_publication', channel: 'facebook', work_item_id: 'wi-fb',
  title: '캐러셀 FB', published_at: '2026-09-04T00:00:00Z', external_url: null, connection_id: 'conn-2',
  d1: { status: 'captured', normalized: { impressions: 150, reach: null, views: null, engagements: null, clicks: null, spend: null, conversions: null, inflow_sessions: null, inflow_users: null }, captured_at: '2026-09-05T00:00:00Z' },
  d7: null,
  asset_sha256s: ['abcdefabcdef1111'], hook_key: null,
};
const GROUPABLE_ROW_THREADS = {
  publication_id: 'pub-th', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-th',
  title: '단일 소재', published_at: '2026-09-03T00:00:00Z', external_url: null, connection_id: 'conn-3',
  d1: null, d7: null,
  asset_sha256s: ['zzzzzzzzzzzz9999'], hook_key: 'hook-A',
};

describe('InsightsBoardPage — 소재/훅 묶음 토글(story #3656, 목 데이터)', () => {
  it('기본값(묶음=없음)은 무회귀 — 그룹 헤더 행이 안 뜨고 기존처럼 행마다 하나씩', async () => {
    stubFetch({ page1: [GROUPABLE_ROW_IG, GROUPABLE_ROW_FB, GROUPABLE_ROW_THREADS] });
    await mount();
    expect(container.querySelectorAll('[data-testid="insights-board-group-header"]').length).toBe(0);
    expect(container.querySelectorAll('[data-testid="insights-board-row"]').length).toBe(3);
  });

  it('묶음=소재 — 같은 asset_sha256s[0]을 공유하는 IG·FB가 한 그룹(대표=sha256 앞 8자)으로, 단일 소재(threads)는 별도 그룹으로 묶인다', async () => {
    stubFetch({ page1: [GROUPABLE_ROW_IG, GROUPABLE_ROW_FB, GROUPABLE_ROW_THREADS] });
    await mount();
    await openMenuAndClick('insights-board-group-by-trigger', koMessages.insightsBoard.groupByCreative);
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('group_by=asset');

    // 다른 URL-쿼리 필터(window/status/metric)와 같은 관례 — useSearchParams는
    // 정적 목이라 router.replace가 실제 URL을 안 바꾼다, 재장착으로 갱신을 흉내낸다.
    useSearchParamsMock.mockReturnValue(new URLSearchParams('group_by=asset'));
    await act(async () => { root.render(wrap(<InsightsBoardPage />)); });
    await flush();

    const headers = [...container.querySelectorAll('[data-testid="insights-board-group-header"]')];
    expect(headers).toHaveLength(2);
    expect(headers[0]!.querySelector('[data-testid="insights-board-group-label"]')?.textContent).toBe('abcdefab');
    expect(container.querySelectorAll('[data-testid="insights-board-row"]').length).toBe(3);
  });

  it('묶음=훅 — hook_key가 null인 FB는 「미분류」(docs 재사용) 그룹으로, IG·threads는 hook-A 그룹으로 합쳐진다', async () => {
    stubFetch({ page1: [GROUPABLE_ROW_IG, GROUPABLE_ROW_FB, GROUPABLE_ROW_THREADS] });
    await mount();
    await openMenuAndClick('insights-board-group-by-trigger', koMessages.insightsBoard.groupByHook);
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('group_by=hook');

    useSearchParamsMock.mockReturnValue(new URLSearchParams('group_by=hook'));
    await act(async () => { root.render(wrap(<InsightsBoardPage />)); });
    await flush();

    const headers = [...container.querySelectorAll('[data-testid="insights-board-group-header"]')];
    const labels = headers.map((h) => h.querySelector('[data-testid="insights-board-group-label"]')?.textContent);
    expect(labels).toEqual(['hook-A', koMessages.docs.indexCategoryUncategorized]);
    const hookAHeader = headers[0]!;
    expect(hookAHeader.textContent).toContain(koMessages.insightsBoard.groupMemberCount.replace('{n}', '2'));
  });
});
