// @vitest-environment jsdom
//
// story #3934(실사고 — 3928 라이브 실측, 유나) — 목표(epic_id) 미할당 스토리가 「목록」 탭
// 그룹핑에서 통째로 빠져 실제로 스토리가 있어도 "표시할 일감이 없어요"로 오독됐다. 소스
// 텍스트/순수함수 가드만으로는 렌더 결함을 못 잡는다(memory feedback-render-test-over-
// source-grep) — org-briefing-shell.test.tsx 선례를 따라 실제로 mount해 헤더 문구를 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import type { FetchedWorkList } from './fetch-work-list';
import { storySelfRow } from './work-list-test-fixtures';

const { fetchWorkListMock, searchParamsValueRef, replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  fetchWorkListMock: vi.fn<(projectId: string) => Promise<FetchedWorkList>>(),
  searchParamsValueRef: { current: '' as string },
}));

vi.mock('./fetch-work-list', () => ({
  fetchWorkList: (projectId: string) => fetchWorkListMock(projectId),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
  usePathname: () => '/work-list',
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
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
          selfRow: storySelfRow('s1', '미할당 스토리'),
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
    expect(container.textContent).not.toContain('표시할 일감이 없어요');
    expect(container.textContent).toContain('미분류');
    expect(container.textContent).toContain('미할당 스토리');
  });

  it('그룹이 정말 0개면(실제로 일이 없으면) 여전히 빈 상태를 보인다', async () => {
    fetchWorkListMock.mockResolvedValue({ workList: { groups: [], partial: false, totalStoryCount: 0 }, hypotheses: [] });
    await mount();
    expect(container.textContent).toContain('표시할 일감이 없어요');
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
describe('WorkListShell — 목표 진행률 단위 낱말(story #3976 · 4888: 단위는 스토리)', () => {
  it('⭐진행률 문구에 단위 낱말("스토리")이 함께 있다', async () => {
    fetchWorkListMock.mockResolvedValue(unassignedOnlyPayload());
    await mount();
    expect(container.textContent).toContain('스토리 0/1개 완료');
  });
});

// story #3934(재판정 — PO Test Org deploy92 실사고, 페드루 PO AC2(b) 2026-09-16 03:47Z) —
// "표시할 일감이 없어요"(전체 부정)가 스토리는 있지만(totalStoryCount>0) task로 안 쪼개진
// 경우에도 그대로 떠서 "프로젝트에 일이 없다"고 오독시켰다. 필터 없이 groups가 0개인데
// totalStoryCount>0이면 사실대로 정정된 문구를 보여야 한다.
describe('WorkListShell — 일이 없는 스토리도 행이다(story #3934 재판정 → #4888 스토리 단위)', () => {
  it('⭐일(task · 실행)이 하나도 없는 스토리도 목록에 보이고, «일 N개» 부제는 없다', async () => {
    const payload = unassignedOnlyPayload();
    payload.workList.groups[0]!.stories[0]!.rows = [];
    fetchWorkListMock.mockResolvedValue(payload);
    await mount();
    expect(container.textContent).toContain('미할당 스토리');
    expect(container.textContent).not.toContain('아직 일로 나뉜 작업이 없어요'); // the old line that hid stories is gone
    expect(container.querySelector('[data-story-id="s1"]')?.textContent).not.toContain('일 0개');
    expect(container.querySelector('[data-testid="story-work-rows"]')).toBeNull();
  });

  it('⭐스토리 행도 산출물 · 저위험 칩을 단다(일이 없는 스토리라도)', async () => {
    const payload = unassignedOnlyPayload();
    const story = payload.workList.groups[0]!.stories[0]!;
    story.rows = [];
    story.selfRow = { ...story.selfRow, artifactCount: 2, lowRisk: true };
    fetchWorkListMock.mockResolvedValue(payload);
    await mount();
    const text = container.querySelector('[data-story-id="s1"]')!.textContent ?? '';
    expect(text).toContain('산출물 2');
    expect(text).toContain('저위험');
  });

  it('⭐스토리 단위 칩(산출물 · 스토리 결재의 저위험)은 스토리 줄에만 있고 그 밑 일 줄에서 되풀이되지 않는다', async () => {
    const payload = unassignedOnlyPayload();
    const story = payload.workList.groups[0]!.stories[0]!;
    story.selfRow = { ...story.selfRow, artifactCount: 3, lowRisk: true };
    story.rows = story.rows.map((r) => ({ ...r, artifactCount: 3, lowRisk: true, state: 'awaiting_approval' as const, stateFromStory: true }));
    fetchWorkListMock.mockResolvedValue(payload);
    await mount();
    const text = (sel: string) => container.querySelector(sel)?.textContent ?? '';
    expect(text('[data-story-id="s1"] > [data-slot="ds-list-row"]')).toContain('산출물 3');
    expect(text('[data-testid="story-work-rows"]')).not.toContain('산출물');
    expect(text('[data-testid="story-work-rows"]')).not.toContain('저위험');
    expect(text('[data-testid="story-work-rows"]')).not.toContain('승인 대기'); // said once, on the story row
  });

  it('«검토 중»은 다른 상태보다 굵게(예전 목록이 따로 두던 유일한 상태) · 완료는 완료색', async () => {
    const payload = unassignedOnlyPayload();
    payload.workList.groups[0]!.stories[0]!.status = 'in-review';
    fetchWorkListMock.mockResolvedValue(payload);
    await mount();
    expect(container.querySelector('[data-testid="story-status-badge"]')?.className).toContain('font-semibold');
    const payload2 = unassignedOnlyPayload();
    payload2.workList.groups[0]!.stories[0]!.status = 'backlog';
    fetchWorkListMock.mockResolvedValue(payload2);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount();
    expect(container.querySelector('[data-testid="story-status-badge"]')?.className).not.toContain('font-semibold');
  });

  it('일이 있는 스토리는 «일 N개 · 위임 M개» 부제를 달고, 일은 스토리 밑에 들여 쓴다', async () => {
    fetchWorkListMock.mockResolvedValue(unassignedOnlyPayload());
    await mount();
    const story = container.querySelector('[data-story-id="s1"]')!;
    expect(story.textContent).toContain('일 1개 · 위임 0개');
    expect(story.querySelector('[data-testid="story-work-rows"]')?.textContent).toContain('할일1');
  });

  it('필터가 걸려 groups가 0개일 때는 «조건에 맞는 일감이 없어요» + 필터 안내를 보인다', async () => {
    searchParamsValueRef.current = 'goal=some-goal-id';
    fetchWorkListMock.mockResolvedValue({ workList: { groups: [], partial: false, totalStoryCount: 20 }, hypotheses: [] });
    await mount();
    expect(container.textContent).toContain('조건에 맞는 일감이 없어요');
    expect(container.textContent).toContain('필터를 바꾸거나 풀어 보세요');
  });

  it('목표 구역은 구역 머리(건수 배지 + 접힘)로 그려지고, 접으면 스토리가 숨는다', async () => {
    fetchWorkListMock.mockResolvedValue(unassignedOnlyPayload());
    await mount();
    const section = container.querySelector('section[data-goal-id]')!;
    expect(section.querySelector('[data-slot="ds-section-header"] [data-slot="ds-count-badge"]')?.textContent).toBe('1');
    const toggle = section.querySelector('button[aria-expanded="true"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    expect(section.querySelector('[data-story-id]')).toBeNull();
  });

  it('스토리 행을 누르면 선택(URL ?row=)이 그 스토리(story:<id>)가 되고, 선택돼 있으면 행이 눌림 표시를 하며 다시 누르면 풀린다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))); // the detail panel opens on the story and reads its own data: nothing answers here
    fetchWorkListMock.mockResolvedValue(unassignedOnlyPayload());
    await mount();
    const row = () => container.querySelector('[data-story-id="s1"] > [data-slot="ds-list-row"]') as HTMLElement;
    expect(row().getAttribute('aria-pressed')).toBe('false');
    replaceMock.mockClear();
    await act(async () => { row().click(); });
    expect(replaceMock).toHaveBeenCalledWith('/work-list?row=story%3As1');
    // the selection lives in the URL: once it says so, the row shows pressed; a second press clears it
    searchParamsValueRef.current = 'row=story:s1';
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount();
    expect(row().getAttribute('aria-pressed')).toBe('true');
    replaceMock.mockClear();
    await act(async () => { row().click(); });
    expect(replaceMock).toHaveBeenCalledWith('/work-list');
  });
});

// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 본문에 별도 마스트헤드가 없어(3946 AC1 실측) TopBarSlot의 h1이 그대로 유일한 h1이다.
// 별도 파일 내 별도 mount — 기존 wrap()에 소비처를 얹으면 그 존의 container.textContent
// 부분일치 단언들(위 describe들)에 title 문구가 섞여드는 위험이 있어, 이 자리만 좁게 둔다.
function TopBarTitleProbe() {
  const { title } = useTopBar();
  return <div>{title}</div>;
}

describe('WorkListShell — 페이지 h1 1개(story #3946)', () => {
  it('⭐h1이 정확히 1개다(TopBarSlot 제목)', async () => {
    fetchWorkListMock.mockResolvedValue({ workList: { groups: [], partial: false, totalStoryCount: 0 }, hypotheses: [] });
    const { WorkListShell } = await import('./work-list-shell');
    await act(async () => {
      root.render(wrap(<><TopBarTitleProbe /><WorkListShell projectId="p1" /></>));
    });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});
