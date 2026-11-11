// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면, PO 11-11 결정 ②) — 하루 체크인 «현재 스프린트» 요약의 스토리 수는 처음 40개만 읽어 부분 수였다(5581이 «N+»로 정직하게 보이게 함).
// 이제 스탠드업이 활성 스프린트의 번다운(stories_count)을 한 번 읽어, 다음 쪽이 남아 있어도 스토리 수를 늘 정확하게 보인다. 태스크 진척은 번다운에 없어 부분일 때 «d+/t+» 하한 그대로.
// 번다운이 실패하면 «N+»로 내려간다(틀린 수를 정확한 척하지 않는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/components/standup/board-bridge-modal', () => ({ BoardBridgeModal: () => null }));
vi.mock('@/components/standup/standup-board-card', () => ({ StandupBoardCard: () => null }));
vi.mock('@/components/standup/standup-feedback-dialog', () => ({ StandupFeedbackDialog: () => null }));
vi.mock('@/components/standup/standup-history-section', () => ({ StandupHistorySection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const S = koMessages.standup;
let burndownCalls: string[];

type Burndown = 'ok' | 'http-fail' | 'reject' | 'bad-shape';
function stubFetch(opts: { firstCount: number; next: string | null; secondCount?: number; burndown?: Burndown; storiesTotal?: number; sprintStatus?: string; noSprint?: boolean }) {
  const row = (i: number) => ({ id: `s-${i}`, title: `스토리 ${i}`, status: 'in-progress', assignee_id: null, sprint_id: 'sp1', project_id: 'p1' });
  burndownCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/burndown')) {
      burndownCalls.push(url);
      if (opts.burndown === 'reject') throw new Error('network down');
      if (opts.burndown === 'http-fail') return { ok: false, json: async () => null };
      if (opts.burndown === 'bad-shape') return { ok: true, json: async () => ({ data: { stories_count: 'many', done_count: null } }) };
      return { ok: true, json: async () => ({ data: { stories_count: opts.storiesTotal ?? 48, done_count: 5, total_points: 10, done_points: 2, remaining_points: 8, completion_pct: 20, ideal_line: [], actual_line: [] } }) };
    }
    if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: opts.noSprint ? [] : [{ id: 'sp1', title: '진행중 스프린트', status: opts.sprintStatus ?? 'active', start_date: null, end_date: null }] }) };
    if (url.includes('/api/stories?project_id=')) {
      const isSecond = url.includes('cursor=');
      const count = isSecond ? (opts.secondCount ?? 0) : opts.firstCount;
      const offset = isSecond ? opts.firstCount : 0;
      return { ok: true, json: async () => ({ data: Array.from({ length: count }, (_, i) => row(offset + i)), meta: { nextCursor: isSecond ? null : opts.next } }) };
    }
    if (url.includes('/api/tasks?story_id=')) return { ok: true, json: async () => ({ data: [], meta: { totalCount: 2, doneCount: 1 } }) };
    if (url.includes('/api/team-members') || url.includes('/api/standup/feedback') || url.includes('/api/standup/missing')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgTimezone: 'Asia/Seoul' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount() {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StandupPage projectId="proj-1" embedded /></NextIntlClientProvider>); });
  for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const text = () => container.textContent ?? '';
const fmt = (tpl: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((a, [k, v]) => a.replace(`{${k}}`, String(v)), tpl);
const count = (needle: string) => text().split(needle).length - 1;

describe('하단 요약 — 번다운으로 스토리 수를 늘 정확하게(story #4888)', () => {
  it('⭐다음 쪽이 남아 있어도(40개 + 커서) 번다운의 정확한 수(48)가 머리 배지와 카드 줄에 나온다 — «이상»이 아니다', async () => {
    stubFetch({ firstCount: 40, next: 'c1', storiesTotal: 48 });
    await mount();
    const exact = fmt(S.sprintStoryCount, { count: 48 });
    expect(exact).toBe('스토리 48개');
    expect(count(exact)).toBeGreaterThanOrEqual(2); // 머리 배지 + 카드 줄
    expect(text()).not.toContain(fmt(S.sprintStoryCountPartial, { count: 40 }));
    expect(text()).not.toContain('이상');
  });

  it('⭐태스크 진척은 번다운에 없어 부분일 때 «d+/t+» 하한 그대로다(스토리 수만 정확)', async () => {
    stubFetch({ firstCount: 40, next: 'c1', storiesTotal: 48 });
    await mount();
    expect(text()).toContain(fmt(S.taskProgressPartial, { done: 40, total: 80 })); // 태스크 40+/80+개 완료
    expect(text()).not.toContain(fmt(S.taskProgress, { done: 40, total: 80 }));
  });

  it('⭐번다운은 활성 스프린트에 대해 정확히 한 번만 읽는다(새 읽기 하나)', async () => {
    stubFetch({ firstCount: 40, next: 'c1', storiesTotal: 48 });
    await mount();
    expect(burndownCalls).toHaveLength(1);
    expect(burndownCalls[0]).toContain('/api/sprints/sp1/burndown');
  });

  it('⭐번다운이 실패하면(HTTP 실패 · 네트워크 끊김 · 모양 이상) 예전처럼 «N+»로 내려간다 — 틀린 수를 정확한 척하지 않고, 화면은 오류로 막히지 않는다', async () => {
    for (const burndown of ['http-fail', 'reject', 'bad-shape'] as const) {
      stubFetch({ firstCount: 40, next: 'c1', burndown });
      await act(async () => { root.unmount(); });
      container.remove();
      container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
      vi.resetModules();
      await mount();
      expect(text(), burndown).toContain(fmt(S.sprintStoryCountPartial, { count: 40 }));
      expect(text(), burndown).not.toContain(S.loadFailed);
    }
  });

  it('⭐다음 쪽이 없으면(전부 불러옴) 목록 길이 그대로 정확한 수 — 번다운 값에 흔들리지 않는다', async () => {
    stubFetch({ firstCount: 3, next: null, storiesTotal: 99 });
    await mount();
    expect(text()).toContain(fmt(S.sprintStoryCount, { count: 3 }));
    expect(text()).not.toContain('99');
    expect(text()).not.toContain('이상');
  });

  it('⭐「더 보기」로 끝까지 불러와도 정확한 수(48)가 그대로다', async () => {
    stubFetch({ firstCount: 40, next: 'c1', secondCount: 8, storiesTotal: 48 });
    await mount();
    await act(async () => { (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === S.loadMore) as HTMLButtonElement;
    expect(more).toBeTruthy();
    await act(async () => { more.click(); });
    for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(text()).toContain(fmt(S.sprintStoryCount, { count: 48 }));
    expect(text()).toContain(fmt(S.taskProgress, { done: 48, total: 96 }));
    expect(text()).not.toContain('이상');
  });

  it('활성 스프린트가 없으면 번다운을 읽지 않는다(읽을 대상이 없다)', async () => {
    stubFetch({ firstCount: 0, next: null, noSprint: true });
    await mount();
    expect(burndownCalls).toHaveLength(0);
    expect(text()).toContain(S.noActiveSprint);
  });
});
