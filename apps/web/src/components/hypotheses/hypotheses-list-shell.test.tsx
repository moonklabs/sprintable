// @vitest-environment jsdom
//
// story #3989(「일감」 흡수 3/N·FE) — 일감 「가설」 보기. work-list-shell.test.tsx와
// 동형 mount 패턴(fetchHypotheses mock+실 렌더) — 상태 필터·행 이동·빈 문구 2종·
// 오류+재시도 갈래를 실제 DOM으로 잰다.
//
// story #3989 CHANGES(페드루 PO) — fetchWorkList(8개 Promise.all)를 통째로 부르던
// 처음 처방은 무관한 원본(예: inbox) 실패에도 이 화면이 오류로 떨어지는 결함이었다.
// fetchHypotheses(`/api/hypotheses?project_id=` 1콜)로 좁힌 뒤 재작성.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import type { WorkListHypothesisInput } from '@/components/work-list/derive-work-list';

const { fetchHypothesesMock, searchParamsValueRef, pushMock, replaceMock } = vi.hoisted(() => ({
  fetchHypothesesMock: vi.fn<(projectId: string) => Promise<WorkListHypothesisInput[]>>(),
  searchParamsValueRef: { current: '' as string },
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('@/components/work-list/fetch-work-list', () => ({
  fetchHypotheses: (projectId: string) => fetchHypothesesMock(projectId),
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
  fetchHypothesesMock.mockReset();
  pushMock.mockReset();
  replaceMock.mockReset();
  searchParamsValueRef.current = '';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount() {
  const { HypothesesListShell } = await import('./hypotheses-list-shell');
  await act(async () => {
    root.render(wrap(<HypothesesListShell projectId="proj-1" />));
  });
}

describe('HypothesesListShell — story #3989', () => {
  it('⭐/api/hypotheses 딱 1콜만 나간다(다른 work-list 원본이 실패해도 무관 — fetchWorkList 8콜 Promise.all 안 씀)', async () => {
    fetchHypothesesMock.mockResolvedValue([]);
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(fetchHypothesesMock).toHaveBeenCalledTimes(1);
    expect(fetchHypothesesMock).toHaveBeenCalledWith('proj-1');
    // 렌더 자체가 성공했다는 것 = inbox/artifacts 등 무관 원본이 실패해도 이 mock이
    // 그 원본들을 아예 안 건드리므로(fetchWorkList 안 씀) 영향을 안 받는다는 증거.
    expect(container.textContent).toContain('아직 가설이 없어요');
  });

  it('전수 가설 0 — 「아직 가설이 없어요」', async () => {
    fetchHypothesesMock.mockResolvedValue([]);
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('아직 가설이 없어요');
  });

  it('불러오기 실패 — 오류 문구+「다시 시도」로 재요청', async () => {
    fetchHypothesesMock.mockRejectedValueOnce(new Error('boom'));
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('불러오지 못했어요');

    fetchHypothesesMock.mockResolvedValueOnce([]);
    const retryBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '다시 시도');
    await act(async () => { retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchHypothesesMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('아직 가설이 없어요');
  });

  it('행 클릭 시 /{ws}/{proj}/flow?hypothesis=<id>로 이동한다(가설 상세, 기존 flow 딥링크 재사용)', async () => {
    fetchHypothesesMock.mockResolvedValue([
      { id: 'h1', statement: '리뷰 에이전트를 붙이면 결함이 준다', status: 'measuring', epic_ids: [], story_ids: [] },
    ]);
    await mount();
    await act(async () => { await Promise.resolve(); });

    const row = [...container.querySelectorAll('button')].find((b) => b.textContent === '리뷰 에이전트를 붙이면 결함이 준다');
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/moonklabs/sprintable/flow?hypothesis=h1');
  });

  it('story_ids가 있으면 「연결된 일 보기」가 뜨고, 클릭 시 work-list의 기존 hypothesis 필터로 이동한다', async () => {
    fetchHypothesesMock.mockResolvedValue([
      { id: 'h1', statement: '연결됨', status: 'active', epic_ids: [], story_ids: ['s1'] },
      { id: 'h2', statement: '연결안됨', status: 'active', epic_ids: [], story_ids: [] },
    ]);
    await mount();
    await act(async () => { await Promise.resolve(); });

    const ctas = [...container.querySelectorAll('button')].filter((b) => b.textContent === '연결된 일 보기');
    expect(ctas.length).toBe(1);
    await act(async () => { ctas[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/moonklabs/sprintable/work-list?hypothesis=h1');
  });

  it('상태 필터 칩 클릭 시 URL의 status 쿼리로 반영되고(SSOT) aria-pressed도 갈린다, 목록도 그 상태만 남는다', async () => {
    fetchHypothesesMock.mockResolvedValue([
      { id: 'h1', statement: '측정 중 가설', status: 'measuring', epic_ids: [], story_ids: [] },
      { id: 'h2', statement: '확定된 가설', status: 'verified', epic_ids: [], story_ids: [] },
    ]);
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('측정 중 가설');
    expect(container.textContent).toContain('확定된 가설');

    const allChip = [...container.querySelectorAll('button')].find((b) => b.textContent === '전체');
    expect(allChip?.getAttribute('aria-pressed')).toBe('true');

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
    const allChipAfter = [...container.querySelectorAll('button')].find((b) => b.textContent === '전체');
    expect(allChipAfter?.getAttribute('aria-pressed')).toBe('false');
    const measuringChipAfter = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('측정 중'));
    expect(measuringChipAfter?.getAttribute('aria-pressed')).toBe('true');
  });

  // story #3989 CHANGES(페드루 PO ②) — «전혀 없음»과 «필터에 맞는 것 없음»은 다른 사실.
  it('⭐가설은 있는데 고른 상태엔 없으면 「고른 상태에 맞는 가설이 없어요」+「필터 지우기」(전혀 없음과 다른 문구)', async () => {
    fetchHypothesesMock.mockResolvedValue([
      { id: 'h1', statement: '확定된 가설', status: 'verified', epic_ids: [], story_ids: [] },
    ]);
    searchParamsValueRef.current = 'status=killed';
    await mount();
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('고른 상태에 맞는 가설이 없어요');
    expect(container.textContent).not.toContain('아직 가설이 없어요');

    const clearBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '필터 지우기');
    expect(clearBtn).toBeTruthy();
    await act(async () => { clearBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(replaceMock).toHaveBeenCalledWith('/hypotheses');
  });
});
