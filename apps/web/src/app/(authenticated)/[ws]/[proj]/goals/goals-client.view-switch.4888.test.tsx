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

async function mount(projectId = 'proj-1', m: typeof koMessages = koMessages) {
  const { GoalsClient } = await import('./goals-client');
  await act(async () => { root.render(wrap(<GoalsClient projectId={projectId} />, m)); });
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
