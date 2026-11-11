// @vitest-environment jsdom
//
// story #4888(UI-5 보드 머리 통째, AC3 §4-3) — 머리 4겹(탭줄 · 렌즈 · 필터줄 · …)을 «탭줄 + 한 줄»로: 렌즈 칩(headLead)이 보드 머리 줄 **안** 맨 앞에 서서 렌즈 + 필터 + 검색 · 보기 전환이 한 줄이다.
// 넓은 화면(lg)은 모자라면 줄바꿈, 폰은 줄바꿈 없이 가로로 미는 한 줄. 눌리는 것은 터치에서 44. 새 기능 0.
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
const B = koMessages.board;

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
}
function stubEventSource() {
  class FakeEventSource { onopen = null; onmessage = null; onerror = null; constructor(_u: string) {} addEventListener() {} close() {} }
  vi.stubGlobal('EventSource', FakeEventSource);
}
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container);
  bannerSlot = document.createElement('div'); document.body.appendChild(bannerSlot);
  root = createRoot(container);
  stubStorage(); stubEventSource();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human', bottomDockBannerSlot: bannerSlot });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/stories?')) return { ok: true, json: async () => ({ data: [], meta: { nextCursor: null, hasMore: false } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); bannerSlot.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount(withLead: boolean) {
  const { KanbanBoard } = await import('./kanban-board');
  const { ToastProvider } = await import('@/components/ui/toast');
  const { RealtimeProvider } = await import('@/components/realtime-provider');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <RealtimeProvider currentTeamMemberId="me-1"><ToastProvider>
          <KanbanBoard projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" headLead={withLead ? <div data-testid="lens-lead">렌즈</div> : undefined} />
        </ToastProvider></RealtimeProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); });
}
const head = () => container.querySelector('[data-testid="board-head"]') as HTMLElement;
const cls = (e: Element) => e.className.split(/\s+/);
const controls = () => [...head().querySelectorAll('button, [role="tab"]')].filter((e) => !e.closest('[data-testid="lens-lead"]')) as HTMLElement[];

describe('보드 머리 — 렌즈 + 필터 + 보기 전환이 한 줄(story #4888)', () => {
  it('⭐렌즈(headLead)가 보드 머리 줄 안 맨 앞에 서고, 그 뒤에 필터 · 오른쪽 묶음이 같은 줄에 있다', async () => {
    await mount(true);
    expect(head()).not.toBeNull();
    expect(head().firstElementChild!.getAttribute('data-testid')).toBe('lens-lead');
    // 렌즈 다음 구분선(장식) → 필터 묶음 → 오른쪽 묶음, 전부 같은 줄 컨테이너의 직계 자식
    const kids = [...head().children];
    expect(kids[1]!.getAttribute('aria-hidden')).toBe('true');
    expect(kids.some((k) => k.contains([...head().querySelectorAll('button')].find((b) => b.textContent === B.filterAll)!))).toBe(true);
    expect(kids[kids.length - 1]!.className).toContain('ml-auto');
  });

  it('⭐headLead가 없으면(다른 호출처) 구분선도 렌즈 자리도 없다 — 보드는 예전 모양 그대로', async () => {
    await mount(false);
    expect(head().querySelector('[data-testid="lens-lead"]')).toBeNull();
    expect(head().querySelector('[aria-hidden="true"].w-px')).toBeNull();
    expect(head().firstElementChild!.className).not.toContain('ml-auto');
  });

  it('⭐폰은 줄바꿈 없이 가로로 미는 한 줄(flex-nowrap · overflow-x-auto · focus-inset), 넓은 화면(lg)은 줄바꿈을 허용한다', async () => {
    await mount(true);
    const c = cls(head());
    expect(c).toContain('flex-nowrap');
    expect(c).toContain('overflow-x-auto');
    expect(c).toContain('focus-inset');
    expect(c).toContain('lg:flex-wrap');
    expect(c).toContain('lg:overflow-visible');
  });

  it('⭐머리의 눌리는 것(필터 · 칩 · 검색 · 보기 전환 · 축 탭)이 전부 터치에서 44 — 하나도 빠지지 않는다', async () => {
    await mount(true);
    const list = controls();
    expect(list.length).toBeGreaterThanOrEqual(9);
    for (const el of list) {
      expect(cls(el), el.getAttribute('aria-label') ?? el.textContent ?? el.className).toContain('touch:min-h-11');
      expect(cls(el), el.getAttribute('aria-label') ?? el.textContent ?? el.className).toContain('touch:min-w-11');
    }
  });

  it('⭐검색 아이콘 단추에 이름이 있다(예전엔 툴팁뿐) · 누르면 검색 칸이 나오고 그 칸도 터치 44', async () => {
    await mount(true);
    const search = head().querySelector(`button[aria-label="${B.searchPlaceholder}"]`) as HTMLButtonElement;
    expect(search).not.toBeNull();
    await act(async () => { search.click(); });
    const input = head().querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(cls(input)).toContain('touch:h-11');
  });

  it('⭐보드 ↔ 목록 보기 전환은 그대로 동작한다(aria-pressed가 옮겨 간다)', async () => {
    await mount(true);
    const boardBtn = head().querySelector(`button[aria-label="${B.boardViewLabel}"]`) as HTMLButtonElement;
    const listBtn = head().querySelector(`button[aria-label="${B.listViewLabel}"]`) as HTMLButtonElement;
    expect(boardBtn.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { listBtn.click(); });
    expect(listBtn.getAttribute('aria-pressed')).toBe('true');
    expect(boardBtn.getAttribute('aria-pressed')).toBe('false');
  });
});
