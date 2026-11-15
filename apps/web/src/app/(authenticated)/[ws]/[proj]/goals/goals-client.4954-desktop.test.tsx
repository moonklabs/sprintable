// @vitest-environment jsdom
//
// story 4954 (the desktop app's goals list) — a double-click on a goal row opens the goal's own page; a right-click opens a menu at the pointer with only what the goal already has:
// «전체 보기» · «목표 수정» · (a rule) · «목표 삭제» (the same confirmation window; a person only; «수정» only where the detail column stands beside the list). Reverting any of it → RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

const { pushMock, hypothesesMock } = vi.hoisted(() => ({ pushMock: vi.fn(), hypothesesMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('./goals-context', () => ({ useGoalsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
// the hypotheses block is its own, shared screen part (the goal page uses it too) — here only «is it mounted for this goal» matters
vi.mock('@/components/hypotheses/hypotheses-section', () => ({
  HypothesesSection: (props: { epicId: string; projectId: string }) => {
    hypothesesMock(props);
    return <div data-testid="hypotheses-stub" data-epic={props.epicId} />;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const G1 = { id: 'g1', title: '첫 고객 10명', status: 'active', priority: 'medium', created_at: '2026-11-01T00:00:00Z', total_stories: 6, done_stories: 1, outcome_status: 'pending', measure_after: '2026-11-24T09:00:00Z', target_date: '2026-11-24T09:00:00Z', target_sp: 20, description: '첫 열 명의 고객을 만난다', hypothesis_count: 0, position: null, latest_story_activity_at: new Date().toISOString() };
const G2 = { id: 'g2', title: '런칭 주간 준비', status: 'active', priority: 'high', created_at: '2026-11-02T00:00:00Z', total_stories: 41, done_stories: 13, outcome_status: 'hit', position: null, latest_story_activity_at: new Date().toISOString() };
const G3 = { id: 'g3', title: '지난 분기 정리', status: 'done', priority: 'low', created_at: '2026-10-01T00:00:00Z', total_stories: 4, done_stories: 4, outcome_status: 'miss', position: null };
const G4 = { id: 'g4', title: '결과 판정 없이 닫힌 것', status: 'done', priority: 'critical', created_at: '2026-09-01T00:00:00Z', total_stories: 0, done_stories: 0, outcome_status: 'unmeasured', position: null };
const GOALS = [G1, G2, G3, G4];

const STORIES = {
  g1: [{ id: 's1', title: '인터뷰 질문지', status: 'done', story_points: 3 }, { id: 's2', title: '모집 글', status: 'in-progress', story_points: 5 }],
  g3: [1, 2, 3, 4].map((n) => ({ id: `t${n}`, title: `정리 ${n}`, status: 'done' })),
};

function stubMedia(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: wide && /min-width:\s*1024px/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
}

function stubFetch(opts: { goals?: unknown[]; detail?: (id: string) => { ok: boolean; body?: unknown } } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/goals?')) return { ok: true, status: 200, json: async () => ({ data: opts.goals ?? GOALS }) };
    const m = typeof url === 'string' ? url.match(/\/api\/goals\/([^/?]+)$/) : null;
    if (m && (!init || !init.method || init.method === 'GET')) {
      const id = m[1]!;
      if (opts.detail) { const r = opts.detail(id); return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body ?? null }; }
      return { ok: true, status: 200, json: async () => ({ data: { id, project_id: 'proj-1', stories: (STORIES as Record<string, unknown[]>)[id] ?? [] } }) };
    }
    if (m && init?.method === 'PATCH') {
      // BE's edit answer carries no story counts (those ride on the list only)
      const { total_stories: _t, done_stories: _d, ...withoutCounts } = G1;
      return { ok: true, status: 200, json: async () => ({ data: { ...withoutCounts, title: '고친 제목' } }) };
    }
    return { ok: false, status: 404, json: async () => null };
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  pushMock.mockReset();
  hypothesesMock.mockReset();
  // Each test gets its OWN browser storage. The screen remembers the chosen view per project (`goals-view:<project>`): the «스윔레인» test leaves `swimlane` behind, and
  // wherever storage really persists inside one file (Node 22 jsdom · CI) the NEXT test would open the swimlane — head but no detail column (5623's CI red on the en test).
  // Where it does not persist (Node >= 25 here) the order dependence never showed. A fresh Map per test makes the result the same on both.
  const lsStore = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => { lsStore.set(k, v); },
    removeItem: (k: string) => { lsStore.delete(k); },
    clear: () => { lsStore.clear(); },
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(locale: 'ko' | 'en' = 'ko', props: Record<string, unknown> = {}) {
  const { GoalsClient } = await import('./goals-client');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <GoalsClient projectId="proj-1" {...props} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const rowOf = (id: string) => q(`[data-testid="goal-row"][data-row-key="${id}"]`)!;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };
const menu = () => document.body.querySelector<HTMLElement>('[data-testid="goal-row-menu"]');
const items = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((b) => b.textContent?.trim());
// a real right-press is a pointerdown with button 2 first (the list's drag sensor sees it) and the contextmenu after; a real double-click is two clicks (the first one chooses the row) then dblclick
const rightClick = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 2, buttons: 2, pointerType: 'mouse', clientX: 300, clientY: 200 })); });
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200, button: 2 }); await act(async () => { el.dispatchEvent(e); }); await flush(); return e;
};
const dbl = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => { (el as HTMLElement).click(); }); await act(async () => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); }); await flush(); };
const pick = async (id: string) => { await act(async () => { (menu()!.querySelector(`[data-testid="${id}"]`) as HTMLElement).click(); }); await flush(); };

describe('[SID:4954] goals list — double-click and right-click', () => {
  it('⭐a double-click on a row opens the goal\'s own page (the same address as «전체 보기»); a double-click on the row\'s own button does not', async () => {
    stubMedia(true); stubFetch(); await mount();
    await dbl(rowOf('g2').querySelector('[data-row-focus]')!); expect(pushMock).not.toHaveBeenCalled(); // on the title BUTTON: not the row's open
    await dbl(rowOf('g2')); expect(pushMock).toHaveBeenCalledTimes(1); expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/goals/g2'); // reverted → RED
  });
  it('⭐a right-click replaces the browser\'s: the menu holds «전체 보기 · 목표 수정 · (rule) · 목표 삭제» in that order, the delete item last', async () => {
    stubMedia(true); stubFetch(); await mount();
    const e = await rightClick(rowOf('g1'));
    expect(e.defaultPrevented).toBe(true);
    expect(items()).toEqual([koMessages.goals.viewFull, koMessages.goals.editGoal, koMessages.goals.deleteGoal]);
    expect(menu()!.querySelector('[role="separator"]')).not.toBeNull(); // the rule before the delete
    const kids = [...menu()!.children].map((c) => c.getAttribute('role'));
    expect(kids.indexOf('separator')).toBe(kids.length - 2); // …the rule sits right before the last item
  });
  it('«전체 보기» goes to the goal\'s page', async () => {
    stubMedia(true); stubFetch(); await mount();
    await rightClick(rowOf('g3')); await pick('goal-row-open');
    expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/goals/g3'); expect(menu()).toBeNull();
  });
  it('⭐«목표 수정» chooses THAT goal and opens the edit form in the detail column beside the list (once — choosing another goal later does not open it)', async () => {
    stubMedia(true); stubFetch(); await mount();
    await rightClick(rowOf('g2')); await pick('goal-row-edit');
    expect(q('[data-testid="goal-detail"]')?.getAttribute('data-goal-id')).toBe('g2');
    expect(q('[data-testid="goal-detail"] form, [data-testid="goal-detail"] input, [data-testid="goal-detail"] textarea')).not.toBeNull(); // the edit form (reverted → the plain detail)
    await act(async () => { (rowOf('g3') as HTMLElement).click(); }); await flush();
    expect(q('[data-testid="goal-detail"]')?.getAttribute('data-goal-id')).toBe('g3');
    expect(q('[data-testid="goal-detail"] form')).toBeNull(); // a plain choice shows the plain detail
    await act(async () => { (rowOf('g2') as HTMLElement).click(); }); await flush(); // back to the goal that was asked to edit: the request was taken ONCE — the plain detail, not the form again
    expect(q('[data-testid="goal-detail"]')?.getAttribute('data-goal-id')).toBe('g2'); expect(q('[data-testid="goal-detail"] form')).toBeNull();
  });
  it('⭐«목표 삭제» asks first (the same confirmation window) and deletes nothing until it is confirmed', async () => {
    stubMedia(true); stubFetch(); await mount();
    await rightClick(rowOf('g4')); await pick('goal-row-delete');
    expect(document.body.textContent).toContain(koMessages.goals.deleteConfirmTitle);
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });
  it('⭐an agent is not offered «목표 삭제» (the row\'s own delete is a person\'s only): the rule goes with it', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'agent' });
    stubMedia(true); stubFetch(); await mount();
    await rightClick(rowOf('g1'));
    expect(items()).toEqual([koMessages.goals.viewFull, koMessages.goals.editGoal]); expect(menu()!.querySelector('[role="separator"]')).toBeNull();
  });
  it('on a narrow screen (no detail column) «목표 수정» is not drawn: «전체 보기 · 목표 삭제» only', async () => {
    stubMedia(false); stubFetch(); await mount();
    await rightClick(rowOf('g1'));
    expect(items()).toEqual([koMessages.goals.viewFull, koMessages.goals.deleteGoal]);
  });
  it('Esc closes the menu and the focus goes back to the row\'s title button', async () => {
    stubMedia(true); stubFetch(); await mount();
    await rightClick(rowOf('g2'));
    await act(async () => { menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }); await flush();
    await vi.waitFor(() => expect(menu()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(rowOf('g2').querySelector('[data-row-focus]')));
  });
  it('⭐«목표 수정» on the goal that is ALREADY chosen opens its edit form (the column is already on screen)', async () => {
    stubMedia(true); stubFetch(); await mount();
    const chosen = q('[data-testid="goal-detail"]')!.getAttribute('data-goal-id')!;
    await rightClick(rowOf(chosen)); await pick('goal-row-edit');
    expect(q('[data-testid="goal-detail"] form')).not.toBeNull();
  });
  it('⭐changing the project drops what pointed at the old project\'s list: an open menu closes and a pending delete confirmation is withdrawn (its goal belongs to the project that was left)', async () => {
    stubMedia(true); stubFetch(); await mount();
    await rightClick(rowOf('g1')); await pick('goal-row-delete');
    expect(document.body.textContent).toContain(koMessages.goals.deleteConfirmTitle);
    await mount('ko', { projectId: 'proj-2' });
    expect(document.body.textContent).not.toContain(koMessages.goals.deleteConfirmTitle); // reverted → the old project's confirmation stays and could delete its goal
    expect(menu()).toBeNull();
  });
});
