// @vitest-environment jsdom
//
// story #3934(실사고 — 3928 라이브 실측, 유나) — 목표(epic_id) 미할당 스토리가 「목록」 탭
// 그룹핑에서 통째로 빠져 실제로 스토리가 있어도 "표시할 일이 없어요"로 오독됐다. 소스
// 텍스트/순수함수 가드만으로는 렌더 결함을 못 잡는다(memory feedback-render-test-over-
// source-grep) — org-briefing-shell.test.tsx 선례를 따라 실제로 mount해 헤더 문구를 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import type { FetchedWorkList } from './fetch-work-list';

const { fetchWorkListMock, searchParamsValueRef } = vi.hoisted(() => ({
  fetchWorkListMock: vi.fn<(projectId: string) => Promise<FetchedWorkList>>(),
  searchParamsValueRef: { current: '' as string },
}));

vi.mock('./fetch-work-list', () => ({
  fetchWorkList: (projectId: string) => fetchWorkListMock(projectId),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
  usePathname: () => '/work-list',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
  searchParamsValueRef.current = '';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function unassignedOnlyPayload(): FetchedWorkList {
  return {
    workList: {
      groups: [{
        goalId: '__unassigned_goal__',
        title: '',
        isActive: false,
        doneCount: 0,
        totalCount: 1,
        assignedCount: 1,
        delegatedCount: 0,
        hypothesisCount: 0,
        stories: [{
          storyId: 's1',
          title: '미할당 스토리',
          status: 'backlog',
          hypothesisIds: [],
          rows: [{
            id: 't1', kind: 'task', workItemType: 'task', workItemId: 't1', title: '할일1',
            ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0, state: null,
          }],
        }],
      }],
      partial: false,
      totalStoryCount: 1,
    },
    hypotheses: [],
  };
}

async function mount() {
  const { WorkListShell } = await import('./work-list-shell');
  await act(async () => { root.render(wrap(<WorkListShell projectId="p1" />)); });
}

describe('WorkListShell — 목표 미할당 스토리(story #3934)', () => {
  it('미할당 스토리만 있어도 빈 상태가 아니라 「미분류」 그룹으로 그려진다', async () => {
    fetchWorkListMock.mockResolvedValue(unassignedOnlyPayload());
    await mount();
    expect(container.textContent).not.toContain('표시할 일이 없어요');
    expect(container.textContent).toContain('미분류');
    expect(container.textContent).toContain('미할당 스토리');
  });

  it('그룹이 정말 0개면(실제로 일이 없으면) 여전히 빈 상태를 보인다', async () => {
    fetchWorkListMock.mockResolvedValue({ workList: { groups: [], partial: false, totalStoryCount: 0 }, hypotheses: [] });
    await mount();
    expect(container.textContent).toContain('표시할 일이 없어요');
  });

  // story #3976(AC3, PO 확定) — 「목표 없음」 그룹에만 안내 문장(그 외 목표는 문장 0).
  it('⭐「미분류」 그룹에는 안내 문장이 함께 뜬다', async () => {
    fetchWorkListMock.mockResolvedValue(unassignedOnlyPayload());
    await mount();
    expect(container.textContent).toContain('목표에 안 묶인 일이에요');
  });
});

// story #3976(AC5, PO 확定) — 스토리 카드 배지는 Story.status SSOT(entity-status-labels.ts).
// work-list-row.tsx의 파생 실행상태(STATE_TEXT)와 다른 축이라 섞지 않는다.
describe('WorkListShell — 스토리 카드 상태 배지(Story.status SSOT, story #3976)', () => {
  it('⭐ready-for-dev → 「착수 대기」로 렌더된다(work-list 행 상태 어휘와 무관)', async () => {
    const payload = unassignedOnlyPayload();
    payload.workList.groups[0]!.stories[0]!.status = 'ready-for-dev';
    fetchWorkListMock.mockResolvedValue(payload);
    await mount();
    expect(container.querySelector('[data-testid="story-status-badge"]')?.textContent).toBe('착수 대기');
  });

  it('done → 「완료」로 렌더된다', async () => {
    const payload = unassignedOnlyPayload();
    payload.workList.groups[0]!.stories[0]!.status = 'done';
    fetchWorkListMock.mockResolvedValue(payload);
    await mount();
    expect(container.querySelector('[data-testid="story-status-badge"]')?.textContent).toBe('완료');
  });
});

// story #3976(AC4, PO 확定) — 진행률 분수는 기존 일+실행 개수 그대로(SP 기준 새 콜 0),
// 단위 낱말만 붙여 무엇을 센 것인지 보이게 한다.
describe('WorkListShell — 목표 진행률 단위 낱말(story #3976)', () => {
  it('⭐진행률 문구에 단위 낱말("일")이 함께 있다', async () => {
    fetchWorkListMock.mockResolvedValue(unassignedOnlyPayload());
    await mount();
    expect(container.textContent).toContain('일 0/1개 완료');
  });
});

// story #3934(재판정 — PO Test Org deploy92 실사고, 페드루 PO AC2(b) 2026-09-16 03:47Z) —
// "표시할 일이 없어요"(전체 부정)가 스토리는 있지만(totalStoryCount>0) task로 안 쪼개진
// 경우에도 그대로 떠서 "프로젝트에 일이 없다"고 오독시켰다. 필터 없이 groups가 0개인데
// totalStoryCount>0이면 사실대로 정정된 문구를 보여야 한다.
describe('WorkListShell — task 0개(목표 유무 무관, story #3934 재판정)', () => {
  it('스토리는 있지만(task 0개) groups가 0개면 "일로 안 쪼개짐" 문구를 보인다(전체 부정 문구 아님)', async () => {
    fetchWorkListMock.mockResolvedValue({ workList: { groups: [], partial: false, totalStoryCount: 20 }, hypotheses: [] });
    await mount();
    expect(container.textContent).not.toContain('표시할 일이 없어요');
    expect(container.textContent).toContain('아직 일로 나뉜 작업이 없어요');
    expect(container.textContent).toContain('보드');
  });

  it('필터가 걸려 groups가 0개일 때는(totalStoryCount>0이어도) 기존 빈 상태 문구를 유지한다', async () => {
    searchParamsValueRef.current = 'goal=some-goal-id';
    fetchWorkListMock.mockResolvedValue({ workList: { groups: [], partial: false, totalStoryCount: 20 }, hypotheses: [] });
    await mount();
    expect(container.textContent).toContain('표시할 일이 없어요');
    expect(container.textContent).not.toContain('아직 일로 나뉜 작업이 없어요');
  });
});
