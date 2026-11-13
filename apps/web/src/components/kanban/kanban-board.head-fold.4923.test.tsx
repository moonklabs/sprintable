// @vitest-environment jsdom
//
// story #4923(보드 · 맥 작은 창) — 진짜 KanbanBoard 머리: 세 묶음(래더 241 + 거르기 460 + 보기 전환 259 ≈ 985px)이 머리 폭에 안 들어가면 거르기가 «거르기 · n» 단추 + 팝오버로 접힌다.
// 지금 기능 → 새 자리: 거르기 조작 하나하나가 팝오버 안에 그대로(담당자 종류 탭 · 스프린트 · 목표 · 담당자 · 라벨 칩) · 검색 · 보기 전환 · 축 탭 · 래더는 줄에 그대로 · 숨긴 N은 접히지 않음. 새 기능 0.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (<div>{title}{actions}</div>) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 1024 }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('./story-card', () => ({ StoryCard: ({ story }: { story: { title: string } }) => <div>{story.title}</div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let bannerSlot: HTMLDivElement;
let observed: Array<{ el: Element; cb: () => void }> = [];
let headWidth = 748;
let desktop = true;
const B = koMessages.board;

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
}
function stubEventSource() {
  class FakeEventSource { onopen = null; onmessage = null; onerror = null; constructor(_u: string) {} addEventListener() {} close() {} }
  vi.stubGlobal('EventSource', FakeEventSource);
}
function stubLayout() {
  // 머리 줄을 지켜보는 관찰자만 손으로 부른다(dnd-kit 같은 다른 부품의 관찰자는 entries를 기대해 건드리지 않는다)
  vi.stubGlobal('ResizeObserver', class { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe(el: Element) { observed.push({ el, cb: this.cb }); } unobserve() {} disconnect() { observed = observed.filter((o) => o.cb !== this.cb); } });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1024') ? desktop : false, addEventListener() {}, removeEventListener() {} }));
  // 머리의 직계 자식 폭: 래더(lens-lead) 241 · 구분선 1 · 거르기 묶음 펼침 460 / 접힘 110 · 오른쪽 묶음 259
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      const el = this as HTMLElement;
      if (el.getAttribute('data-testid') === 'lens-lead') return 241;
      if (el.getAttribute('aria-hidden') === 'true' && el.className.includes('w-px')) return 1;
      if (el.getAttribute('data-slot') === 'board-head-filters') return el.getAttribute('data-folded') === 'true' ? 110 : 460;
      if (el.className.includes('ml-auto')) return 259;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).getAttribute('data-testid') === 'board-head' ? headWidth : 0; } });
}
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container);
  bannerSlot = document.createElement('div'); document.body.appendChild(bannerSlot);
  root = createRoot(container);
  observed = []; headWidth = 748; desktop = true;
  stubStorage(); stubEventSource(); stubLayout();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human', bottomDockBannerSlot: bannerSlot });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/stories?')) return { ok: true, json: async () => ({ data: [{ id: 's1', title: '숨긴 카드', status: 'backlog', priority: 'medium', is_excluded: true, project_id: 'proj-1', org_id: 'o', assignee_id: null, assignee_ids: [], position: 0, created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z' }], meta: { nextCursor: null, hasMore: false } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove(); bannerSlot.remove(); vi.unstubAllGlobals(); vi.resetModules();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth; delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

async function mount() {
  const { KanbanBoard } = await import('./kanban-board');
  const { ToastProvider } = await import('@/components/ui/toast');
  const { RealtimeProvider } = await import('@/components/realtime-provider');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <RealtimeProvider currentTeamMemberId="me-1"><ToastProvider>
          <KanbanBoard projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" headLead={<div data-testid="lens-lead">렌즈</div>} />
        </ToastProvider></RealtimeProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}
const head = () => container.querySelector('[data-testid="board-head"]') as HTMLElement;
const group = () => head().querySelector('[data-slot="board-head-filters"]') as HTMLElement;
const trigger = () => head().querySelector('[data-testid="board-filter-fold"]') as HTMLButtonElement | null;
const popup = () => document.querySelector('[data-slot="board-filter-popover"]') as HTMLElement | null;
const btn = (root_: ParentNode, text: string) => Array.from(root_.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined;
const fire = async () => { await act(async () => { observed.filter((o) => o.el.getAttribute('data-testid') === 'board-head').forEach((o) => o.cb()); }); };

describe('[SID:4923] 보드 머리 — 한 줄에 안 들어가면 거르기가 접힌다', () => {
  it('⭐머리 폭 748(맥 앱 1100 창): 거르기 묶음이 «거르기» 단추 하나로 접혀 있고 조작 칩은 줄에 없다', async () => {
    await mount();
    expect(group().getAttribute('data-folded')).toBe('true');
    expect(trigger()!.textContent).toBe(B.filterFoldLabel);
    expect(btn(head(), B.allSprints)).toBeUndefined();
    expect(btn(head(), B.filterMembers)).toBeUndefined();
  });

  it('⭐머리 폭 1088(1440 창): 지금처럼 펼친 채 — 단추 없음, 칩이 줄 안에 그대로', async () => {
    headWidth = 1088;
    await mount();
    expect(group().getAttribute('data-folded')).toBe('false');
    expect(trigger()).toBeNull();
    for (const label of [B.filterAll, B.filterMembers, B.filterAgents, B.allSprints, B.allEpics, B.allAssignees]) expect(btn(head(), label), label).toBeDefined();
  });

  it('창 폭을 넓히면 접힌 머리가 펴지고, 다시 좁히면 접힌다', async () => {
    await mount();
    expect(group().getAttribute('data-folded')).toBe('true');
    headWidth = 1100; await fire();
    expect(group().getAttribute('data-folded')).toBe('false');
    headWidth = 700; await fire();
    expect(group().getAttribute('data-folded')).toBe('true');
  });

  it('⭐폰(lg 아래)은 접지 않는다 — 가로로 미는 한 줄 그대로', async () => {
    desktop = false;
    await mount();
    expect(group().getAttribute('data-folded')).toBe('false');
    expect(trigger()).toBeNull();
  });

  it('⭐지금 기능 → 새 자리: 팝오버 안에 담당자 종류 탭 셋 · 스프린트 · 목표 · 담당자 칩이 전부 있다(빠진 것 0)', async () => {
    await mount();
    await act(async () => { trigger()!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const p = popup()!;
    expect(p).not.toBeNull();
    for (const label of [B.filterAll, B.filterMembers, B.filterAgents, B.allSprints, B.allEpics, B.allAssignees]) expect(btn(p, label), label).toBeDefined();
    // 담당자 종류 탭은 aria-pressed 그대로
    expect(btn(p, B.filterAll)!.getAttribute('aria-pressed')).toBe('true');
  });

  it('⭐팝오버 안에서 거르면 적용되고 단추가 «거르기 · 1»이 된다(n = 적용 중인 거르기 수)', async () => {
    await mount();
    await act(async () => { trigger()!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { btn(popup()!, B.filterMembers)!.click(); });
    expect(btn(popup()!, B.filterMembers)!.getAttribute('aria-pressed')).toBe('true');
    expect(trigger()!.textContent).toBe(koMessages.board.filterFoldLabelActive.replace('{count}', '1'));
  });

  it('⭐검색 · 보기 전환 · 축 탭 · 래더는 접혀도 줄에 그대로 있다', async () => {
    await mount();
    expect(head().querySelector('[data-testid="lens-lead"]')).not.toBeNull();
    expect(head().querySelector(`button[aria-label="${B.searchPlaceholder}"]`)).not.toBeNull();
    expect(head().querySelector(`button[aria-label="${B.boardViewLabel}"]`)).not.toBeNull();
    expect(head().querySelector(`button[aria-label="${B.listViewLabel}"]`)).not.toBeNull();
    expect(head().querySelector(`[role="tablist"][aria-label="${B.trustAxisView}"]`)).not.toBeNull();
  });

  it('⭐낮은 창(높이 ≤ 520)에서 머리 줄은 더 낮고(min-h-9 · py-0.5) 보드 틀 위아래 여백은 8(py-2)이다 — 높이 쪽 규칙이 클래스에 있다', async () => {
    await mount();
    for (const c of ['[@media(max-height:520px)]:min-h-9', '[@media(max-height:520px)]:py-0.5']) expect(head().classList.contains(c), c).toBe(true);
    const flow = readFileSync(join(__dirname, '..', '..', 'app', '(authenticated)', '[ws]', '[proj]', 'flow', 'flow-client.tsx'), 'utf8');
    expect(flow).toContain('py-4 [@media(max-height:520px)]:py-2" data-testid="flow-board-frame"');
  });

  it('⭐숨긴 N(제외된 카드 수)은 접혀도 줄에 보인다(조용히 사라지는 카드가 없게 — story #2187)', async () => {
    await mount();
    expect(group().getAttribute('data-folded')).toBe('true');
    expect(head().textContent).toMatch(/\d+건 숨김/);
  });
});
