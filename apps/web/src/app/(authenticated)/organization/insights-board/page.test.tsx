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
}) {
  const page1 = opts.page1 ?? [ROW_A, ROW_B, ROW_C];
  const page1HasMore = opts.page1HasMore ?? false;
  const page1NextCursor = opts.page1NextCursor ?? null;
  const page2 = opts.page2 ?? [];
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
    if (url.includes('/insights-board')) {
      const usingCursor = url.includes('cursor=');
      const rows = usingCursor ? page2 : page1;
      return {
        ok: true, status: 200,
        json: async () => ({ data: { rows, has_more: usingCursor ? false : page1HasMore, next_cursor: usingCursor ? null : page1NextCursor }, error: null, meta: null }),
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

    // Row A: d1=null(미스케줄) · d7=captured 120.
    expect(rows[0]?.querySelector('[data-testid="insights-board-cell-unscheduled"]')).not.toBeNull();
    const rowACells = rows[0]!.querySelectorAll('[data-testid="insights-board-cell-value"]');
    expect(rowACells[0]?.textContent).toBe('120');

    // Row B: d1=pending(상태만) · d7=failed(destructive 톤).
    const rowBStatusCells = rows[1]!.querySelectorAll('[data-testid="insights-board-cell-status"]');
    expect(rowBStatusCells).toHaveLength(2);
    expect(rowBStatusCells[0]?.textContent).toBe(koMessages.content.insightStatusPending);
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
});

describe('InsightsBoardPage — 쿼리 파라미터(story #3503)', () => {
  it('window은 사용자가 뭘 고르든(기본값 포함) 항상 fetch 쿼리에 명시적으로 실린다', async () => {
    const calls = stubFetch({});
    await mount();
    const firstCall = calls.find((c) => c.includes('/insights-board'));
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

  it('정렬 드롭다운에서 항목을 고르면 router.replace 쿼리에 sort가 실린다', async () => {
    stubFetch({});
    await mount();
    await openMenuAndClick('insights-board-sort-trigger', koMessages.insightsBoard.sortImpressionsD1);
    const lastUrl = routerReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('sort=impressions_d1');
  });

  it('필터/정렬/방향이 이미 걸린 URL로 진입하면 그 값 그대로(+window 항상 포함) fetch 쿼리에 실린다', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('channel=threads&status=failed&sort=impressions_d7&sort_dir=asc&window=30d'));
    const calls = stubFetch({});
    await mount();
    const firstCall = calls.find((c) => c.includes('/insights-board'));
    expect(firstCall).toContain('window=30d');
    expect(firstCall).toContain('channel=threads');
    expect(firstCall).toContain('status=failed');
    expect(firstCall).toContain('sort=impressions_d7');
    expect(firstCall).toContain('sort_dir=asc');
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
