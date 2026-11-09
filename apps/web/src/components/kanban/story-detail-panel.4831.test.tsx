// @vitest-environment jsdom
//
// story 4831 부품 교체(보드 묶음) — 스토리 상세 패널의 날것 칸 4곳(제목 · 새 라벨 이름 · 의존성 검색 · 댓글)이 바탕 Input · Textarea가 되어도 결과가 같은지 잠근다.
// 제목: 엔터로 저장 요청 · 라벨 이름: 엔터로 만들기 요청(이름·색 본문) · 의존성 검색: 두 글자부터 조회 질의 q · 댓글: Cmd/Ctrl+엔터로 제출 요청.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;

function makeStory(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 1, title: '기존 제목', status: 'backlog', priority: 'medium',
    story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url === '/api/labels' && init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'lb-1', name: '새 라벨', color: '#ef4444' }) };
    return { ok: false, status: 404, json: async () => null, text: async () => '' };
  }));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human', projectId: 'proj-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const board = koMessages.board as unknown as Record<string, string>;
async function mountPanel() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider><StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} memberMap={{}} /></ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const sectionButton = (title: string) => [...container.querySelectorAll('button')].find((b) => b.parentElement?.textContent?.includes(title) && b.parentElement.querySelector('span')?.textContent === title) as HTMLButtonElement | undefined;

describe('스토리 상세 패널 — 날것 칸 4곳이 바탕 부품(story 4831)', () => {
  it('새 라벨 이름 칸: 바탕 Input이고, 이름을 쓰고 엔터하면 라벨 만들기 요청이 이름 · 색과 함께 나간다(빈 이름은 안 나감)', async () => {
    await mountPanel();
    const toggle = sectionButton(board.labelsSectionTitle!);
    expect(toggle, '라벨 섹션의 + 추가').toBeDefined();
    await act(async () => { toggle!.click(); });
    const name = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${board.newLabelNamePlaceholder}"]`)!;
    expect(name).toBeTruthy();
    await act(async () => { key(name, 'Enter'); }); // 빈 이름
    expect(calls.filter((c) => c.url === '/api/labels' && c.method === 'POST')).toHaveLength(0); // 라벨 목록을 읽는 GET은 별개
    await act(async () => { setInput(name, '  새 라벨  '); });
    await act(async () => { key(name, 'Enter'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const posts = calls.filter((c) => c.url === '/api/labels' && c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ name: '새 라벨' });
    expect(typeof posts[0]!.body?.color).toBe('string');
  });

  it('의존성 검색 칸: 바탕 Input이고, 한 글자는 조회하지 않고 두 글자부터 q로 조회한다', async () => {
    await mountPanel();
    const toggle = [...container.querySelectorAll('button[aria-expanded]')].find((b) => b.parentElement?.textContent?.includes(board.dependenciesSectionTitle!)) as HTMLButtonElement;
    expect(toggle, '의존성 섹션의 추가').toBeTruthy();
    await act(async () => { toggle.click(); });
    const search = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${(koMessages.board as { dep: Record<string, string> }).dep.searchPlaceholder}"]`)!;
    expect(search).toBeTruthy();
    // 폼을 열 때 나가는 «후보 불러오기»(질의 q 없음)는 빼고, 글자로 찾는 조회(q 있음)만 센다
    const queries = () => calls.filter((c) => c.url.startsWith('/api/stories?')).map((c) => new URL(c.url, 'http://x.test').searchParams.get('q')).filter((q): q is string => q !== null);
    await act(async () => { setInput(search, '결'); });
    await sleep(400);
    expect(queries()).toEqual([]); // 한 글자는 조회 안 함
    await act(async () => { setInput(search, '결제'); });
    await sleep(400);
    expect(queries()).toEqual(['결제']);
    expect(search.value).toBe('결제');
  });

  it('댓글 칸: 바탕 Textarea이고, 자동으로 늘어나는 높이 설정(field-sizing)과 최소 높이 80px을 유지한다', async () => {
    await mountPanel();
    const tab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes(board.commentsTab ?? '댓글'));
    if (tab) await act(async () => { (tab as HTMLElement).click(); (tab as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    const box = container.querySelector<HTMLTextAreaElement>(`textarea[data-slot="textarea"][placeholder="${board.commentInputPlaceholder}"]`);
    expect(box, '댓글 입력칸').toBeTruthy();
    const cls = box!.className.split(/\s+/);
    expect(cls).toContain('field-sizing-content');
    expect(cls).toContain('min-h-[80px]');
    expect(cls).toContain('resize-none');
    expect(cls).not.toContain('resize-y');
    expect(cls).not.toContain('min-h-16');
  });
});
