// @vitest-environment jsdom
//
// story #3989(「일감」 흡수 3/N·FE) — 일감 「가설」 보기. work-list-shell.test.tsx와
// 동형 mount 패턴(fetchWorkList mock+실 렌더) — 상태 필터·행 이동·빈 문구·오류+재시도
// 4갈래를 실제 DOM으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import type { FetchedWorkList } from '@/components/work-list/fetch-work-list';

const { fetchWorkListMock, searchParamsValueRef, pushMock, replaceMock } = vi.hoisted(() => ({
  fetchWorkListMock: vi.fn<(projectId: string) => Promise<FetchedWorkList>>(),
  searchParamsValueRef: { current: '' as string },
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('@/components/work-list/fetch-work-list', () => ({
  fetchWorkList: (projectId: string) => fetchWorkListMock(projectId),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
  usePathname: () => '/hypotheses',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useParams: () => ({ ws: 'moonklabs', proj: 'sprintable' }),
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider>{node}</TopBarProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWorkListMock.mockReset();
  pushMock.mockReset();
  replaceMock.mockReset();
  searchParamsValueRef.current = '';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function emptyWorkList(): FetchedWorkList['workList'] {
  return { groups: [], partial: false, totalStoryCount: 0 };
}

async function mount() {
  const { HypothesesListShell } = await import('./hypotheses-list-shell');
  await act(async () => {
    root.render(wrap(<HypothesesListShell projectId="proj-1" />));
  });
}

describe('HypothesesListShell — story #3989', () => {
  it('전수 가설 0 — 「아직 가설이 없어요」', async () => {
    fetchWorkListMock.mockResolvedValue({ workList: emptyWorkList(), hypotheses: [] });
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('아직 가설이 없어요');
  });

  it('불러오기 실패 — 오류 문구+「다시 시도」로 재요청', async () => {
    fetchWorkListMock.mockRejectedValueOnce(new Error('boom'));
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('불러오지 못했어요');

    fetchWorkListMock.mockResolvedValueOnce({ workList: emptyWorkList(), hypotheses: [] });
    const retryBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '다시 시도');
    await act(async () => { retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchWorkListMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('아직 가설이 없어요');
  });

  it('행 클릭 시 /{ws}/{proj}/flow?hypothesis=<id>로 이동한다(가설 상세, 기존 flow 딥링크 재사용)', async () => {
    fetchWorkListMock.mockResolvedValue({
      workList: emptyWorkList(),
      hypotheses: [{ id: 'h1', statement: '리뷰 에이전트를 붙이면 결함이 준다', status: 'measuring', epic_ids: [], story_ids: [] }],
    });
    await mount();
    await act(async () => { await Promise.resolve(); });

    const row = [...container.querySelectorAll('button')].find((b) => b.textContent === '리뷰 에이전트를 붙이면 결함이 준다');
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/moonklabs/sprintable/flow?hypothesis=h1');
  });

  it('story_ids가 있으면 「연결된 일 보기」가 뜨고, 클릭 시 work-list의 기존 hypothesis 필터로 이동한다', async () => {
    fetchWorkListMock.mockResolvedValue({
      workList: emptyWorkList(),
      hypotheses: [
        { id: 'h1', statement: '연결됨', status: 'active', epic_ids: [], story_ids: ['s1'] },
        { id: 'h2', statement: '연결안됨', status: 'active', epic_ids: [], story_ids: [] },
      ],
    });
    await mount();
    await act(async () => { await Promise.resolve(); });

    const ctas = [...container.querySelectorAll('button')].filter((b) => b.textContent === '연결된 일 보기');
    expect(ctas.length).toBe(1);
    await act(async () => { ctas[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/moonklabs/sprintable/work-list?hypothesis=h1');
  });

  it('상태 필터 칩 클릭 시 URL의 status 쿼리로 반영되고(SSOT), 목록도 그 상태만 남는다', async () => {
    fetchWorkListMock.mockResolvedValue({
      workList: emptyWorkList(),
      hypotheses: [
        { id: 'h1', statement: '측정 중 가설', status: 'measuring', epic_ids: [], story_ids: [] },
        { id: 'h2', statement: '확定된 가설', status: 'verified', epic_ids: [], story_ids: [] },
      ],
    });
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('측정 중 가설');
    expect(container.textContent).toContain('확定된 가설');

    const measuringChip = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('측정 중'));
    await act(async () => { measuringChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(replaceMock).toHaveBeenCalledWith('/hypotheses?status=measuring');

    // 실제 URL 반영(SSOT)까지 재현 — searchParams가 바뀐 뒤 재마운트해 필터된 결과를 본다.
    searchParamsValueRef.current = 'status=measuring';
    const { HypothesesListShell } = await import('./hypotheses-list-shell');
    await act(async () => { root.render(wrap(<HypothesesListShell projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('측정 중 가설');
    expect(container.textContent).not.toContain('확定된 가설');
  });
});
