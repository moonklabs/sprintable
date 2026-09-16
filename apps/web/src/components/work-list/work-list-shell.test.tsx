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

const { fetchWorkListMock } = vi.hoisted(() => ({
  fetchWorkListMock: vi.fn<(projectId: string) => Promise<FetchedWorkList>>(),
}));

vi.mock('./fetch-work-list', () => ({
  fetchWorkList: (projectId: string) => fetchWorkListMock(projectId),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
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
          hypothesisIds: [],
          rows: [{
            id: 't1', kind: 'task', workItemType: 'task', workItemId: 't1', title: '할일1',
            ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0, state: null,
          }],
        }],
      }],
      partial: false,
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
    fetchWorkListMock.mockResolvedValue({ workList: { groups: [], partial: false }, hypotheses: [] });
    await mount();
    expect(container.textContent).toContain('표시할 일이 없어요');
  });
});
