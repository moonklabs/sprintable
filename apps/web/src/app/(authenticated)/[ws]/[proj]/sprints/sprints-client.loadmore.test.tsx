// @vitest-environment jsdom
//
// story #2190 후속 — 백로그/스프린트 스토리 「더 보기」 회귀가드.
// ① cursor(ISO datetime, '+00:00' 포함)가 encodeURIComponent 없이 템플릿에 들어가면 쿼리
//    스트링에서 '+'가 공백으로 디코드돼 BE가 500을 낸다 — 실제 발사되는 URL에 '+'가 안 남아
//    있는지 검증한다.
// ② loadMore 실패(res.ok=false)가 조용히 삼켜지던 자리 — 실패 시 에러 문구가 렌더되는지 검증.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

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

const SPRINT = { id: 's1', title: 'Sprint 1', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' };
// 실제로 BE가 내는 커서 모양 — '+00:00'을 포함한 ISO datetime.
const CURSOR_WITH_PLUS = '2026-07-24T09:47:33.640536+00:00';

function fetchCallUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mountAndSelect() {
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => { root.render(wrap(<SprintsClient projectId="proj-1" orgId="org-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const row = [...container.querySelectorAll('li')].find((li) => li.textContent?.includes('Sprint 1'));
  await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function findLoadMoreButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent === '더 보기') as HTMLButtonElement[];
}

describe('SprintsClient — 백로그/스프린트 스토리 「더 보기」(story #2190 후속)', () => {
  it('cursor에 "+00:00"이 있어도 실제 요청 URL에 인코딩되지 않은 "+"가 남지 않는다(backlog)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [SPRINT] }) };
      if (url.includes('/burndown')) return { ok: true, json: async () => ({ data: null }) };
      if (url.includes('/api/stories?project_id=')) return { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) };
      if (url.includes('/api/stories/backlog') && !url.includes('cursor=')) {
        return { ok: true, json: async () => ({ data: [{ id: 'b1', title: 'Backlog 1' }], meta: { hasMore: true, nextCursor: CURSOR_WITH_PLUS } }) };
      }
      if (url.includes('/api/stories/backlog') && url.includes('cursor=')) {
        return { ok: true, json: async () => ({ data: [{ id: 'b2', title: 'Backlog 2' }], meta: { hasMore: false, nextCursor: null } }) };
      }
      return { ok: false, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);

    await mountAndSelect();
    const loadMoreBtn = findLoadMoreButtons().find((b) => !b.disabled)!;
    expect(loadMoreBtn).toBeDefined();
    await act(async () => { loadMoreBtn.click(); await Promise.resolve(); await Promise.resolve(); });

    const calledUrls = fetchCallUrls(fetchMock);
    const cursorCall = calledUrls.find((u) => u.includes('/api/stories/backlog') && u.includes('cursor='));
    expect(cursorCall).toBeDefined();
    // 인코딩됐다면 '+'는 %2B로 나타나야 하고, 원시 '+'가 그대로 남아있으면 안 된다
    // (쿼리스트링에서 그 '+'는 공백으로 디코드되어 BE datetime 파싱이 깨진다).
    expect(cursorCall).toContain(encodeURIComponent(CURSOR_WITH_PLUS));
    expect(cursorCall).not.toContain(`cursor=${CURSOR_WITH_PLUS}`); // 원시(미인코딩) 형태 부재 확인
  });

  it('loadMore가 실패(500 등)하면 조용히 삼키지 않고 에러 문구를 보여준다(backlog)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [SPRINT] }) };
      if (url.includes('/burndown')) return { ok: true, json: async () => ({ data: null }) };
      if (url.includes('/api/stories?project_id=')) return { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) };
      if (url.includes('/api/stories/backlog') && !url.includes('cursor=')) {
        return { ok: true, json: async () => ({ data: [{ id: 'b1', title: 'Backlog 1' }], meta: { hasMore: true, nextCursor: CURSOR_WITH_PLUS } }) };
      }
      if (url.includes('/api/stories/backlog') && url.includes('cursor=')) {
        return { ok: false, json: async () => null }; // 500 시뮬레이션
      }
      return { ok: false, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);

    await mountAndSelect();
    const loadMoreBtn = findLoadMoreButtons().find((b) => !b.disabled)!;
    await act(async () => { loadMoreBtn.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('더 불러오지 못했습니다');
  });

  it('cursor에 "+00:00"이 있어도 실제 요청 URL에 인코딩되지 않은 "+"가 남지 않는다(sprint stories)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [SPRINT] }) };
      if (url.includes('/burndown')) return { ok: true, json: async () => ({ data: null }) };
      if (url.includes('/api/stories/backlog')) return { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) };
      if (url.includes('/api/stories?project_id=') && !url.includes('cursor=')) {
        return { ok: true, json: async () => ({ data: [{ id: 's-story-1', title: 'Sprint Story 1' }], meta: { hasMore: true, nextCursor: CURSOR_WITH_PLUS } }) };
      }
      if (url.includes('/api/stories?project_id=') && url.includes('cursor=')) {
        return { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) };
      }
      return { ok: false, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);

    await mountAndSelect();
    const loadMoreBtn = findLoadMoreButtons().find((b) => !b.disabled)!;
    await act(async () => { loadMoreBtn.click(); await Promise.resolve(); await Promise.resolve(); });

    const calledUrls = fetchCallUrls(fetchMock);
    const cursorCall = calledUrls.find((u) => u.includes('/api/stories?project_id=') && u.includes('cursor='));
    expect(cursorCall).toBeDefined();
    expect(cursorCall).toContain(encodeURIComponent(CURSOR_WITH_PLUS));
    expect(cursorCall).not.toContain(`cursor=${CURSOR_WITH_PLUS}`);
  });
});
