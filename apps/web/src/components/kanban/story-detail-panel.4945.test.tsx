// @vitest-environment jsdom
//
// story 4945 — 설명 · 완료 조건 편집기에서 ⌘Enter(Ctrl+Enter)로 저장(댓글 칸은 이미 그랬다). 격리 맥 앱 실측: 설명을 쓰고 ⌘Enter → 입력창이 그대로 열려 있었다(저장 안 됨).
// 한글 조합 중의 Enter는 «글자 확정 키»라 저장이 아니고(4831), 그냥 Enter는 줄바꿈이다.
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
let patches: Array<Record<string, unknown>>;
const STORY: KanbanStory = {
  id: 's1', story_number: 1, title: '제목', status: 'backlog', priority: 'medium', story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
  description: null, acceptance_criteria: null, attachments: null, position: null, success_hypothesis: null, metric_definition: null, measure_after: null,
  outcome_status: 'n_a', outcome_result: null,
};
const board = koMessages.board as unknown as Record<string, string>;
beforeEach(() => {
  patches = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (method === 'PATCH' && url === '/api/stories/s1') { patches.push(body ?? {}); return { ok: true, status: 200, json: async () => ({ data: { ...STORY, ...body } }) }; }
    return { ok: false, status: 404, json: async () => null, text: async () => '' };
  }));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human', projectId: 'proj-1' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mountPanel() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ToastProvider><StoryDetailPanel story={STORY} tasks={[]} onClose={() => {}} memberMap={{}} /></ToastProvider></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const setText = (el: HTMLTextAreaElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
const key = (el: Element, init: KeyboardEventInit) => { const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }); el.dispatchEvent(ev); return ev; };
const openEditor = async (label: string) => {
  const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label))!;
  await act(async () => { btn.click(); });
  return container.querySelector<HTMLTextAreaElement>('textarea')!;
};

describe('설명 · 완료 조건 편집기 ⌘Enter 저장', () => {
  it('⭐설명: ⌘Enter → 그 글로 PATCH 한 번 · Ctrl+Enter도 · 저장 뒤 편집창이 닫힌다', async () => {
    await mountPanel();
    const ta = await openEditor(board.addDescription!);
    await act(async () => { setText(ta, '새 설명'); });
    let ev!: KeyboardEvent;
    await act(async () => { ev = key(ta, { metaKey: true }); });
    await flush();
    expect(patches).toEqual([{ description: '새 설명' }]);
    expect(ev.defaultPrevented).toBe(true);
    expect(container.querySelector('textarea')).toBeNull();
  });
  it('⭐그냥 Enter(줄바꿈) · 한글 조합 중 ⌘Enter는 저장하지 않는다', async () => {
    await mountPanel();
    const ta = await openEditor(board.addDescription!);
    await act(async () => { setText(ta, '쓰는 중'); });
    await act(async () => { key(ta, {}); });
    await act(async () => { key(ta, { metaKey: true, isComposing: true }); });
    await flush();
    expect(patches).toEqual([]);
    expect(container.querySelector('textarea')).not.toBeNull();
    await act(async () => { key(ta, { ctrlKey: true }); }); // Ctrl+Enter(다른 OS 손)는 저장
    await flush();
    expect(patches).toEqual([{ description: '쓰는 중' }]);
  });
  it('⭐완료 조건: ⌘Enter → acceptance_criteria PATCH', async () => {
    await mountPanel();
    const ta = await openEditor(board.addAcceptanceCriteria!);
    await act(async () => { setText(ta, '조건 하나'); });
    await act(async () => { key(ta, { metaKey: true }); });
    await flush();
    expect(patches).toEqual([{ acceptance_criteria: '조건 하나' }]);
  });
});

// 지우기는 닫기(✕) 바로 옆에 늘 떠 있어 잘못 누르기 쉬웠다(PO 11-14) → «더 보기 ⋯» 메뉴 안으로. 같은 동작 · 확인 창은 그대로 · 에이전트 계정에는 ⋯ 도 없다(사람 전용 그대로).
describe('상세 패널 지우기 — «더 보기 ⋯» 안', () => {
  const trash = () => container.querySelector(`button[aria-label="${board.deleteStory}"]`);
  const more = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${board.panelMoreActions}"]`);
  it('⭐늘 떠 있는 «스토리 삭제» 단추가 없고 ⋯ 단추가 있다 · ⋯ → «스토리 삭제»(위험 항목) → 확인 창 → 확인 전엔 삭제 요청 0', async () => {
    await mountPanel();
    expect(trash()).toBeNull();
    expect(more()).not.toBeNull();
    await act(async () => { more()!.click(); });
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => (i.textContent ?? '').trim() === board.deleteStory)!;
    expect(item).toBeDefined();
    expect(item.getAttribute('data-variant')).toBe('danger');
    await act(async () => { item.click(); });
    await flush();
    const confirmBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '영구 삭제');
    expect(confirmBtn, '확인 창').toBeDefined();
    const deletes = (globalThis.fetch as unknown as { mock: { calls: Array<[string, { method?: string }?]> } }).mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deletes).toHaveLength(0);
  });
  it('⭐사람이 아닌 계정에는 ⋯ 도 삭제도 없다(사람 전용 — 서버도 403)', async () => {
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'ag-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'agent', projectId: 'proj-1' });
    await mountPanel();
    expect(more()).toBeNull();
    expect(trash()).toBeNull();
  });
});
