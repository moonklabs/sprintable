// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면, PO 11-11) — 하루 체크인 머리의 «현재 스프린트» 요약 수는 «지금까지 불러온 스토리»(처음 40개 + 더 보기로 이은 쪽)만 센 부분 수다.
// 다음 쪽이 더 있는데 그 수를 정확한 총수처럼 보이면 «틀린 값을 정확한 것처럼» — 더 있을 때는 «N+»(이상)로, 끝까지 불러오면 정확한 수로.
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

type Page = { count: number; next: string | null };
function stubFetch(first: Page, second?: Page) {
  const row = (i: number) => ({ id: `s-${i}`, title: `스토리 ${i}`, status: 'in-progress', assignee_id: null, sprint_id: 'sp1', project_id: 'p1' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [{ id: 'sp1', title: '진행중 스프린트', status: 'active', start_date: null, end_date: null }] }) };
    if (url.includes('/api/stories?project_id=')) {
      const isSecond = url.includes('cursor=');
      const page = isSecond && second ? second : first;
      const offset = isSecond ? first.count : 0;
      return { ok: true, json: async () => ({ data: Array.from({ length: page.count }, (_, i) => row(offset + i)), meta: { nextCursor: page.next } }) };
    }
    if (url.includes('/api/tasks?story_id=')) return { ok: true, json: async () => ({ data: [], meta: { totalCount: 2, doneCount: 1 } }) }; // 스토리마다 태스크 2 · 완료 1
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

describe('하단 요약 — 부분 수는 «N+»로 정직하게(story #4888)', () => {
  it('⭐다음 쪽이 더 있으면(40개 + 커서) 스토리 수 · 태스크 완료/전체가 «이상»으로 보이고 정확한 수처럼 보이지 않는다 — 머리 배지 · 현재 스프린트 카드 둘 다', async () => {
    stubFetch({ count: 40, next: 'c1' });
    await mount();
    const storyPartial = fmt(S.sprintStoryCountPartial, { count: 40 });
    const taskPartial = fmt(S.taskProgressPartial, { done: 40, total: 80 });
    expect(storyPartial).toBe('스토리 40개 이상');
    expect(taskPartial).toBe('태스크 40+/80+개 완료');
    expect(text()).toContain(storyPartial);
    expect(text()).toContain(taskPartial);
    // 정확한 수 문구는 안 나온다
    // «스토리 40개 이상»은 «스토리 40개»를 품으므로, 뒤에 «이상»이 안 붙은 정확한 문구만 찾는다
    expect(text()).not.toMatch(new RegExp(`${fmt(S.sprintStoryCount, { count: 40 })}(?! 이상)`));
    expect(text()).not.toContain(fmt(S.taskProgress, { done: 40, total: 80 }));
    // 두 자리(머리 배지 + 카드 머리)에 모두 «이상»
    expect(text().split(storyPartial).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('⭐다음 쪽이 없으면(커서 없음) 예전처럼 정확한 수 — 「이상」이 안 붙는다', async () => {
    stubFetch({ count: 3, next: null });
    await mount();
    expect(text()).toContain(fmt(S.sprintStoryCount, { count: 3 }));   // 스토리 3개
    expect(text()).toContain(fmt(S.taskProgress, { done: 3, total: 6 })); // 태스크 3/6개 완료
    expect(text()).not.toContain('이상');
    expect(text()).not.toContain('+/');
  });

  it('⭐「더 보기」로 끝까지 불러오면 «이상»이 정확한 수로 바뀐다(40 → 45)', async () => {
    stubFetch({ count: 40, next: 'c1' }, { count: 5, next: null });
    await mount();
    expect(text()).toContain(fmt(S.sprintStoryCountPartial, { count: 40 }));
    // 스프린트 카드를 펼쳐 「더 보기」를 누른다
    await act(async () => { (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === S.loadMore) as HTMLButtonElement;
    expect(more).toBeTruthy();
    await act(async () => { more.click(); });
    for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(text()).toContain(fmt(S.sprintStoryCount, { count: 45 }));
    expect(text()).toContain(fmt(S.taskProgress, { done: 45, total: 90 }));
    expect(text()).not.toContain('이상');
  });
});
