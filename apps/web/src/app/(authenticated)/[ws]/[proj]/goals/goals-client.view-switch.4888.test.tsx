// @vitest-environment jsdom
//
// story #4888(UI-5 목표 화면 첫 조각) — 에픽 탭(/epics 스윔레인)과 목표 화면(/goals)을 한 화면으로: 같은 마스트헤드 아래 «보기: 목록 | 스윔레인».
// 이 파일은 «구성»을 못박는다: 기본은 목록(예전 그대로) · 스윔레인 보기는 보드를 한 곳에만, embedded로(자기 상단바 슬롯 안 그림) · h1은 하나 · 고른 보기는 프로젝트별로 기억.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./goals-context', () => ({ useGoalsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (<div data-testid="top-bar-slot">{title}{actions}</div>),
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
// 보드 자체는 epic-swimlane-board.test.tsx가 쥔다 — 여기선 «어떻게 얹히나»(몇 번 · embedded · projectId)만 본다.
const boardCalls: Array<{ projectId: string; embedded?: boolean }> = [];
vi.mock('@/components/epics/epic-swimlane-board', () => ({
  EpicSwimlaneBoard: (props: { projectId: string; embedded?: boolean }) => { boardCalls.push(props); return <div data-testid="swimlane-board-stub" />; },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const store = new Map<string, string>();
const wrap = (n: React.ReactNode, m: typeof koMessages = koMessages) => <NextIntlClientProvider locale="ko" messages={m} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;

beforeEach(() => {
  boardCalls.length = 0;
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (typeof url === 'string' && url.includes('/api/goals?')
    ? { ok: true, json: async () => ({ data: [{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }] }) }
    : { ok: false, json: async () => null })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount(projectId = 'proj-1', m: typeof koMessages = koMessages, initialView?: 'list' | 'swimlane') {
  const { GoalsClient } = await import('./goals-client');
  await act(async () => { root.render(wrap(<GoalsClient projectId={projectId} initialView={initialView} />, m)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const sw = () => container.querySelector('[data-testid="goals-view-switch"]') as HTMLElement | null;
const viewBtn = (label: string) => [...(sw()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };

describe('GoalsClient — 보기 전환 «목록 | 스윔레인»(story #4888)', () => {
  it('⭐기본은 목록(예전 /goals 그대로) — 전환 단추 둘이 있고 목록 쪽이 눌린 상태 · 스윔레인 보드는 안 그려진다', async () => {
    await mount();
    expect(sw()).not.toBeNull();
    expect(sw()!.getAttribute('aria-label')).toBe(koMessages.goals.viewLabel);
    expect(viewBtn(koMessages.goals.viewList)?.getAttribute('aria-pressed')).toBe('true');
    expect(viewBtn(koMessages.goals.viewSwimlane)?.getAttribute('aria-pressed')).toBe('false');
    expect(container.textContent).toContain('E-CANVAS');
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).toBeNull();
    expect(boardCalls).toHaveLength(0);
  });

  it('⭐스윔레인을 누르면 보드가 «딱 한 번» embedded로 선다 — 목록(행 · 상태 필터)은 사라지고 마스트헤드 h1은 그대로 하나', async () => {
    await mount();
    await click(viewBtn(koMessages.goals.viewSwimlane)!);
    expect(container.querySelectorAll('[data-testid="swimlane-board-stub"]')).toHaveLength(1); // 데스크톱 · 모바일 두 배치에 둘 다 그려지면 2 → RED
    expect(boardCalls.length).toBeGreaterThan(0);
    expect(boardCalls.every((c) => c.embedded === true && c.projectId === 'proj-1')).toBe(true);
    expect(container.textContent).not.toContain('E-CANVAS');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '초안')).toBe(false); // 상태 필터 알약은 목록 보기 몫
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(koMessages.goals.title);
    expect(viewBtn(koMessages.goals.viewSwimlane)?.getAttribute('aria-pressed')).toBe('true');
    // 상단바 슬롯은 목표 화면 것 하나(보드가 자기 것을 안 그린다는 것은 epic-swimlane-board.test의 embedded 단언)
    expect(container.querySelectorAll('[data-testid="top-bar-slot"]')).toHaveLength(1);
  });

  it('목록으로 돌아오면 목록이 다시 선다 · 보드는 내려간다', async () => {
    await mount();
    await click(viewBtn(koMessages.goals.viewSwimlane)!);
    await click(viewBtn(koMessages.goals.viewList)!);
    expect(container.textContent).toContain('E-CANVAS');
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).toBeNull();
  });

  it('⭐고른 보기는 프로젝트별로 기억된다 — 다시 열면 그 보기 · 다른 프로젝트는 기본(목록)', async () => {
    await mount('proj-1');
    await click(viewBtn(koMessages.goals.viewSwimlane)!);
    expect(store.get('goals-view:proj-1')).toBe('swimlane');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.resetModules();
    await mount('proj-1');
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.resetModules();
    await mount('proj-2');
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).toBeNull();
    expect(viewBtn(koMessages.goals.viewList)?.getAttribute('aria-pressed')).toBe('true');
  });

  // codex 5543-goals BLOCKING — 같은 마운트에서 projectId만 바뀌는 이동(프로젝트 전환)에서 이전 프로젝트의 보기가 남으면 다른 프로젝트가 엉뚱한 보기로 열린다.
  // 위 시험은 매번 다시 마운트해 이걸 못 잡았다(거짓 통과) — 여기선 root.render로 같은 마운트에 projectId만 바꿔 건다.
  it('⭐같은 마운트에서 프로젝트만 바뀌어도 그 프로젝트의 보기로 맞춘다 — 스윔레인이던 proj-1에서 proj-2(저장값 없음)로 가면 목록, 다시 proj-1로 오면 스윔레인', async () => {
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await click(viewBtn(koMessages.goals.viewSwimlane)!);
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).not.toBeNull();
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-2" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).toBeNull();
    expect(viewBtn(koMessages.goals.viewList)?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).not.toBeNull();
  });

  it('저장소가 막혀도(getItem · setItem이 던짐) 화면은 서고 이번 전환은 된다', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    await mount();
    expect(sw()).not.toBeNull();
    await click(viewBtn(koMessages.goals.viewSwimlane)!);
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).not.toBeNull();
  });

  it('en 로케일에서도 전환 단추 글이 나온다(ko/en 파리티)', async () => {
    await mount('proj-1', enMessages as unknown as typeof koMessages);
    expect([...sw()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['List', 'Swimlane']);
  });

  it('보기 전환 단추는 ds Button — 폰 누름 영역 44(pointer-coarse:min-h-11)', async () => {
    await mount();
    for (const b of sw()!.querySelectorAll('button')) {
      expect(b.getAttribute('data-slot')).toBe('ds-button');
      expect(b.className.split(/\s+/)).toContain('pointer-coarse:min-h-11');
    }
  });
});

// story #4888(UI-5 목표 화면 둘째 조각) — `/epics`(일감 탭줄의 «목표» 탭)는 같은 화면을 스윔레인으로 연다: 주소가 보기를 정한다(initialView).
describe('GoalsClient — initialView(주소가 보기를 정함, story #4888 둘째 조각)', () => {
  it('⭐initialView="swimlane"이면 저장된 보기가 목록이어도 스윔레인으로 열린다(주소가 저장값보다 먼저) · 보드는 한 번 · embedded · h1 하나', async () => {
    store.set('goals-view:proj-1', 'list');
    await mount('proj-1', koMessages, 'swimlane');
    expect(container.querySelectorAll('[data-testid="swimlane-board-stub"]')).toHaveLength(1);
    expect(boardCalls.every((c) => c.embedded === true)).toBe(true);
    expect(viewBtn(koMessages.goals.viewSwimlane)?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('⭐initialView="list"면 저장된 보기가 스윔레인이어도 목록으로 열린다', async () => {
    store.set('goals-view:proj-1', 'swimlane');
    await mount('proj-1', koMessages, 'list');
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).toBeNull();
    expect(container.textContent).toContain('E-CANVAS');
  });

  it('⭐그 진입에서 누른 전환은 이번 화면만 바꾸고 저장하지 않는다 — /goals가 다음에 열릴 때 기본 보기를 바꾸지 않게(되돌리면 RED)', async () => {
    await mount('proj-1', koMessages, 'swimlane');
    await click(viewBtn(koMessages.goals.viewList)!);
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).toBeNull(); // 이번 화면은 바뀐다
    expect(container.textContent).toContain('E-CANVAS');
    expect(store.has('goals-view:proj-1')).toBe(false); // 저장은 안 한다
  });

  it('⭐initialView가 있으면 같은 마운트에서 프로젝트가 바뀌어도 그 보기로 다시 선다(다른 프로젝트의 저장값이 목록이어도)', async () => {
    store.set('goals-view:proj-2', 'list');
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" initialView="swimlane" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-2" initialView="swimlane" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).not.toBeNull();
  });

  // /epics는 일감 탭줄 아래에 서므로(WorkTabsFrame의 sticky 띠) 화면 높이 앵커가 그 띠 높이(--work-tabs-h)를 빼야 셸이 한 번 더 스크롤되지 않는다(스프린트 화면과 같은 관례).
  it('⭐세 높이 앵커(스윔레인 · 데스크톱 · 모바일)가 모두 탭 띠 높이를 뺀다 — 빼지 않으면 /epics에서 띠 높이만큼 셸이 더 스크롤된다', async () => {
    await mount('proj-1', koMessages, 'swimlane');
    const swim = container.querySelector('[data-testid="goals-swimlane-view"]') as HTMLElement;
    expect(swim.className).toContain('h-[calc(100svh-var(--shell-chrome-h)-var(--work-tabs-h,0px))]');
    await click(viewBtn(koMessages.goals.viewList)!);
    const anchored = [...container.querySelectorAll('div')].filter((d) => d.className.includes('100svh-var(--shell-chrome-h)'));
    expect(anchored.length).toBeGreaterThanOrEqual(2); // 데스크톱 · 모바일 배치
    for (const d of anchored) expect(d.className).toContain('var(--work-tabs-h,0px)');
  });
});

// codex 5543-epics BLOCKING — `/epics`가 목표 목록 읽기를 먼저 기다리면 보드가 원래 쥐던 «느림 vs 멈춤» 표시(story #3019)가 가려지고 같은 /api/goals를 두 번 읽는다.
// 보드를 목 처리한 위 시험은 못 잡았다 — 여기서는 «목록 읽기가 영영 안 끝나도 스윔레인은 선다 · 목록 읽기는 목록 보기에서만»을 읽기 호출로 잰다.
describe('GoalsClient — 스윔레인 보기는 목록 읽기를 기다리지도 하지도 않는다(story #4888 둘째 조각)', () => {
  const goalsListCalls = () => vi.mocked(fetch).mock.calls.filter(([u]) => typeof u === 'string' && u.includes('/api/goals?'));
  const hangGoalsList = () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (typeof url === 'string' && url.includes('/api/goals?')
      ? new Promise(() => {}) // 영영 안 끝난다
      : Promise.resolve({ ok: false, json: async () => null }))));
  };

  it('⭐initialView="swimlane"이면 목록 읽기가 영영 안 끝나도 보드는 선다 · 목록 읽기는 아예 하지 않는다(/api/goals? 0회) · h1 하나', async () => {
    hangGoalsList();
    await mount('proj-1', koMessages, 'swimlane');
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).not.toBeNull();
    expect(goalsListCalls()).toHaveLength(0);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('⭐읽지 않은 동안 마스트헤드는 수를 «정확한 수»처럼 보이지 않는다 — 진행 중 · 완료 수 글이 없다(0 · 0이 아님)', async () => {
    hangGoalsList();
    await mount('proj-1', koMessages, 'swimlane');
    const masthead = container.querySelector('h1')!.parentElement!.textContent ?? '';
    expect(masthead).toContain(koMessages.goals.indexDek);
    expect(masthead).not.toMatch(/진행 중\s*\d|완료\s*\d|active\s*\d/);
    expect(masthead).not.toContain('0 ·');
  });

  it('⭐스윔레인에서 목록 보기로 넘어오면 그때 «딱 한 번» 읽는다 · 읽은 뒤에 목록과 수가 선다', async () => {
    await mount('proj-1', koMessages, 'swimlane');
    expect(goalsListCalls()).toHaveLength(0);
    await click(viewBtn(koMessages.goals.viewList)!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(goalsListCalls()).toHaveLength(1);
    expect(container.textContent).toContain('E-CANVAS');
    expect(container.querySelector('h1')!.parentElement!.textContent).toMatch(/\d/); // 수가 선다
  });

  it('⭐프로젝트가 바뀌면(같은 마운트) 이전 프로젝트의 목록이 남지 않는다 — 새 목록을 읽는 동안은 로딩 자리 · 스윔레인 보기에서는 이전 프로젝트의 수를 안 보인다', async () => {
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-CANVAS');
    hangGoalsList(); // proj-2의 목록은 안 끝난다
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-2" />)); });
    expect(container.textContent).not.toContain('E-CANVAS'); // 이전 프로젝트의 목록이 남지 않는다
    expect(container.textContent).toContain(koMessages.goals.loading);
  });

  // codex 5543-epics 2차 BLOCKING — 프로젝트를 옮기는 사이 응답이 뒤섞이는 경우. 위 시험은 새 프로젝트의 읽기를 «영영 안 끝나게»만 해서 못 잡았다.
  function deferredGoals() {
    type Resolver = (r: { ok: boolean; json: () => Promise<unknown> }) => void;
    const pending = new Map<string, Resolver>();
    const deletes: Resolver[] = []; // 삭제 요청(끝내기 전까지 매달아 둔다)
    const posts: Array<() => void> = []; // 만들기 요청(holdPosts일 때 매달아 둔다)
    let holdPosts = false;
    const calls: Array<{ pid: string; resolve: Resolver }> = []; // 읽기를 시작한 순서대로(같은 프로젝트를 여러 번 읽는 경우 포함)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/goals?')) {
        const pid = new URL(url, 'http://x').searchParams.get('project_id')!;
        return new Promise((resolve) => { pending.set(pid, resolve as never); calls.push({ pid, resolve: resolve as never }); });
      }
      if (typeof url === 'string' && url === '/api/goals' && init?.method === 'POST') {
        const created = { ok: true, json: async () => ({ data: { id: 'goal-new', title: 'E-NEW-GOAL', status: 'draft', priority: 'medium', stories: [] } }) };
        if (holdPosts) return new Promise((resolve) => { posts.push(() => resolve(created)); }); // 만들기 응답을 매달아 둔다
        return Promise.resolve(created);
      }
      if (typeof url === 'string' && /^\/api\/goals\/[^/?]+$/.test(url) && init?.method === 'DELETE') {
        return new Promise((resolve) => { deletes.push(resolve as never); });
      }
      return Promise.resolve({ ok: false, json: async () => null });
    }));
    const goals = (title: string) => ({ ok: true, json: async () => ({ data: [{ id: `id-${title}`, title, status: 'active', story_count: 1, is_ai_generated: false }] }) });
    return { pending, goals, calls, deletes, posts, hold: () => { holdPosts = true; } };
  }

  it('⭐새 프로젝트(B)의 읽기가 먼저 끝나고 이전 프로젝트(A)의 늦은 응답이 나중에 와도 B의 목록이 서고 · A가 덮지 않고 · B가 로딩 자리에 갇히지 않는다', async () => {
    const { pending, goals } = deferredGoals();
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-B" />)); });
    await act(async () => { pending.get('proj-B')!(goals('E-B-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-B-GOAL');
    await act(async () => { pending.get('proj-A')!(goals('E-A-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-B-GOAL');
    expect(container.textContent).not.toContain('E-A-GOAL');
    expect(container.textContent).not.toContain(koMessages.goals.loading); // 로딩 자리에 갇히지 않는다
  });

  it('⭐새 프로젝트(B)의 읽기가 실패해도 이전 프로젝트(A)의 목록이 B 아래 남지 않는다', async () => {
    const { pending, goals } = deferredGoals();
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    await act(async () => { pending.get('proj-A')!(goals('E-A-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-A-GOAL');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-B" />)); });
    await act(async () => { pending.get('proj-B')!({ ok: false, json: async () => null }); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain('E-A-GOAL');
  });

  // codex 3차 BLOCKING — 프로젝트 비교만으로는 같은 프로젝트의 겹친 읽기(A→B→A 이동 · 조직 동기화)에서 오래된 응답이 새 응답을 덮는다. 순번표로 «가장 나중에 시작한 읽기»만 반영.
  it('⭐A → B → A로 옮겨 A를 두 번 읽었을 때 · 나중에 시작한 읽기가 먼저 끝나고 먼저 시작한 오래된 읽기가 늦게 와도 새 응답이 남는다(오래된 응답이 덮지 않는다)', async () => {
    const { goals, calls } = deferredGoals();
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-B" />)); });
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    const aCalls = calls.filter((c) => c.pid === 'proj-A');
    expect(aCalls).toHaveLength(2); // 첫 A 읽기(오래됨) · 되돌아온 A 읽기(새 것)
    await act(async () => { aCalls[1]!.resolve(goals('E-A-NEW')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-A-NEW');
    await act(async () => { aCalls[0]!.resolve(goals('E-A-OLD')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-A-NEW');
    expect(container.textContent).not.toContain('E-A-OLD');
  });

  it('⭐스윔레인 보기로 프로젝트를 옮긴 뒤 목록 보기로 넘어와 새 프로젝트 읽기가 실패해도 이전 프로젝트의 목록은 남지 않는다(이동 시점에 비움)', async () => {
    const { pending, goals } = deferredGoals();
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    await act(async () => { pending.get('proj-A')!(goals('E-A-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-A-GOAL');
    store.set('goals-view:proj-B', 'swimlane'); // B는 스윔레인으로 열린다(프로젝트를 옮기면 그 프로젝트의 보기로 맞춘다)
    const before = vi.mocked(fetch).mock.calls.filter(([u]) => typeof u === 'string' && u.includes('/api/goals?')).length;
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-B" />)); }); // 스윔레인 보기라 B의 목록은 안 읽는다
    expect(container.querySelector('[data-testid="swimlane-board-stub"]')).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => typeof u === 'string' && u.includes('/api/goals?')).length).toBe(before);
    await click(viewBtn(koMessages.goals.viewList)!); // 이제 B의 목록을 읽는다
    await act(async () => { pending.get('proj-B')!({ ok: false, json: async () => null }); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain('E-A-GOAL');
  });

  // codex 4차 BLOCKING 셋 — ① A → B(스윔레인) → A에서 비운 목록을 «읽은 것»으로 보면 0 · 0이 정확한 수처럼 보인다 ② 옛 프로젝트의 클로저가 늦게 다시 읽기를 불러 지금 프로젝트의 읽기를 건드린다 ③ 읽기가 진행 중일 때 만든 목표를 오래된 응답이 덮는다.
  it('⭐A → B(스윔레인) → A로 돌아오면 A의 새 읽기가 끝나기 전까지 «읽은 것» 취급을 하지 않는다 — 로딩 자리 · 비운 목록(빈 상태 · 0 · 0)이 정확한 것처럼 보이지 않는다', async () => {
    const { pending, goals } = deferredGoals();
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    await act(async () => { pending.get('proj-A')!(goals('E-A-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-A-GOAL');
    store.set('goals-view:proj-B', 'swimlane');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-B" />)); }); // B는 스윔레인 — 목록은 안 읽는다
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); }); // A로 돌아온다 — A의 새 읽기가 나가 있다(매달림)
    expect(container.textContent).toContain(koMessages.goals.loading);
    expect(container.textContent).not.toContain(koMessages.goals.noGoals); // 비운 목록을 «진짜 빈 프로젝트»로 보이지 않는다
    expect(container.textContent).not.toContain('E-A-GOAL');
  });

  it('⭐삭제가 실패한 뒤 재읽기를 부르는 옛 프로젝트 클로저가 프로젝트를 옮긴 뒤에 늦게 와도 지금 프로젝트의 읽기를 건드리지 않는다(B가 로딩에 갇히지도 A 목록이 B에 나오지도 않는다)', async () => {
    const { pending, goals, deletes } = deferredGoals();
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    await act(async () => { pending.get('proj-A')!(goals('E-A-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    // A에서 삭제를 눌러 확인까지(요청은 매달림)
    await click(container.querySelector('button[aria-label="목표 삭제"]')!);
    const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.goals.deleteConfirmButton)!;
    await click(confirm);
    expect(deletes).toHaveLength(1);
    // 프로젝트를 B로 옮기고 B의 읽기가 끝난다
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-B" />)); });
    await act(async () => { pending.get('proj-B')!(goals('E-B-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-B-GOAL');
    // 이제 A의 삭제 요청이 «실패»로 끝난다 → 옛 클로저가 A를 다시 읽으려 한다
    await act(async () => { deletes[0]!({ ok: false, json: async () => null }); await Promise.resolve(); await Promise.resolve(); });
    // 거절되지 않았다면 A를 다시 읽는 요청이 나가 있다 — 그 응답이 «끝나도» B 화면에 닿지 않아야 한다(끝나지 않은 채 두면 해가 보이지 않는 헛통과가 된다)
    await act(async () => { pending.get('proj-A')!(goals('E-A-LATE-REFETCH')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-B-GOAL');
    expect(container.textContent).not.toContain(koMessages.goals.loading);
    expect(container.textContent).not.toContain('E-A-GOAL');
    expect(container.textContent).not.toContain('E-A-LATE-REFETCH');
  });

  it('⭐읽기가 진행 중일 때 만든 목표는 그 읽기의 오래된 응답이 와도 사라지지 않는다 — 응답에 없으면 앞에 합쳐 놓는다', async () => {
    const { pending, goals, calls } = deferredGoals();
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
    await act(async () => { pending.get('proj-1')!(goals('E-OLD-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    // 스윔레인 갔다가 목록으로 돌아오면 새 읽기가 나가고(매달림) 목록은 이미 읽은 것이라 그대로 보인다
    await click(viewBtn(koMessages.goals.viewSwimlane)!);
    await click(viewBtn(koMessages.goals.viewList)!);
    expect(calls.filter((c) => c.pid === 'proj-1')).toHaveLength(2);
    expect(container.textContent).toContain('E-OLD-GOAL');
    // 그 사이 새 목표를 만든다
    const gm = koMessages.goals as Record<string, string>;
    await act(async () => { ([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === gm.newGoal)!).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const titleInput = document.body.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${gm.fieldTitlePlaceholder}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(titleInput, 'E-NEW-GOAL'); titleInput.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { ([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === gm.createGoal)!).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    // 새 목표의 제목은 목록 줄에도 오른쪽 상세 패널에도 뜬다 — 글자가 있다는 것만으로는 목록에서 사라져도 통과해 버리니, 글자가 «몇 군데» 뜨는지로 잰다.
    const copies = () => [...container.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent === 'E-NEW-GOAL').length;
    const before = copies();
    expect(before).toBeGreaterThanOrEqual(2); // 목록 줄(데스크톱 · 모바일 배치) + 상세 패널
    // 이제 «만들기 전에 시작한» 읽기의 응답이 온다 — 새 목표가 없다
    await act(async () => { calls.filter((c) => c.pid === 'proj-1')[1]!.resolve(goals('E-OLD-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(copies()).toBe(before); // 목록 줄에서 사라지지 않았다
    expect(container.textContent).toContain('E-OLD-GOAL');
  });

  // codex 5차 BLOCKING — A에서 만들던 목표의 응답이 프로젝트를 B로 옮긴 뒤 도착하면 A의 목표가 B의 목록에 끼어든다.
  it('⭐A에서 목표를 만드는 중(응답 매달림)에 B로 옮기고 그 응답이 B 화면에서 도착해도 A의 새 목표가 B 목록에 끼어들지 않는다', async () => {
    const { pending, goals, posts, hold } = deferredGoals();
    hold();
    const gm = koMessages.goals as Record<string, string>;
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-A" />)); });
    await act(async () => { pending.get('proj-A')!(goals('E-A-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    // A에서 새 목표 만들기를 눌러 응답을 매달아 둔다
    await act(async () => { ([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === gm.newGoal)!).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const titleInput = document.body.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${gm.fieldTitlePlaceholder}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(titleInput, 'E-NEW-GOAL'); titleInput.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { ([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === gm.createGoal)!).click(); });
    expect(posts).toHaveLength(1);
    // B로 옮기고 B의 목록이 선다
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-B" />)); });
    await act(async () => { pending.get('proj-B')!(goals('E-B-GOAL')); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('E-B-GOAL');
    // 이제 A의 만들기 응답이 도착한다
    await act(async () => { posts[0]!(); await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 30)); });
    expect(container.textContent).toContain('E-B-GOAL');
    expect(container.textContent).not.toContain('E-NEW-GOAL');
  });
});
