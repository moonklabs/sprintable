// @vitest-environment jsdom
//
// story 4831 (측정 중 찾은 기존 결함) — 스토리 제목 칸과 새 라벨 이름 칸의 엔터는 저장 · 만들기인데, 한글 조합 중의 엔터는 «글자 확정 키»다.
// 실제 Chromium 실측(전): 제목은 반쯤 쓴 «새 제ㅁ»로 저장되고 편집창이 닫혀 확정된 글자가 사라졌고, 새 라벨 이름은 조합 중 엔터가 «긴급ㅂ» 조직 라벨을 실제로 만들고 확정 뒤 엔터에 «봉»을 또 만들었다.
// 조합 중(isComposing · keyCode 229)의 엔터는 요청을 보내지 않고 기본 동작도 막지 않으며, 조합이 아닌 엔터는 그대로 저장 · 만들기를 한다.
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
let reqs: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
const STORY: KanbanStory = {
  id: 's1', story_number: 1, title: '기존 제목', status: 'backlog', priority: 'medium',
  story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
  description: null, acceptance_criteria: null, attachments: null, position: null,
  success_hypothesis: null, metric_definition: null, measure_after: null,
  outcome_status: 'n_a', outcome_result: null,
};

beforeEach(() => {
  reqs = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    reqs.push({ url, method, body });
    if (method === 'PATCH' && url === '/api/stories/s1') return { ok: true, status: 200, json: async () => ({ data: { ...STORY, title: body?.title } }) };
    if (method === 'POST' && url === '/api/labels') return { ok: true, status: 200, json: async () => ({ id: 'lb-1', name: body?.name, color: body?.color }) };
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
        <ToastProvider><StoryDetailPanel story={STORY} tasks={[]} onClose={() => {}} memberMap={{}} /></ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
function setInput(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const patches = () => reqs.filter((r) => r.method === 'PATCH' && r.url === '/api/stories/s1').map((r) => r.body?.title);
const labelPosts = () => reqs.filter((r) => r.method === 'POST' && r.url === '/api/labels').map((r) => r.body?.name);

describe('스토리 제목 칸 — 한글 조합 중 엔터', () => {
  async function openTitle() {
    await mountPanel();
    await act(async () => { (container.querySelector('h2')!.closest('button') as HTMLButtonElement).click(); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][data-testid="story-title-input"]')!;
    await act(async () => { setInput(input, '새 제ㅁ'); });
    return input;
  }
  it('조합 중의 엔터(isComposing · keyCode 229)는 저장 요청을 보내지 않고 편집창을 닫지 않으며 기본 동작도 막지 않는다', async () => {
    const input = await openTitle();
    let ev!: KeyboardEvent;
    await act(async () => { ev = key(input, 'Enter', { isComposing: true }); });
    await flush();
    expect(patches()).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    expect(container.querySelector('[data-testid="story-title-input"]')).not.toBeNull();
    await act(async () => { key(input, 'Enter', { keyCode: 229 }); });
    await flush();
    expect(patches()).toEqual([]);
  });
  it('조합이 끝난 뒤의 엔터는 확정된 제목을 한 번 저장한다', async () => {
    const input = await openTitle();
    await act(async () => { setInput(input, '새 제목'); });
    await act(async () => { key(input, 'Enter'); });
    await flush();
    expect(patches()).toEqual(['새 제목']);
  });
});

describe('새 라벨 이름 칸 — 한글 조합 중 엔터', () => {
  async function openLabelName() {
    await mountPanel();
    const toggle = [...container.querySelectorAll('button')].find((b) => b.parentElement?.textContent?.includes(board.labelsSectionTitle!) && b.parentElement.querySelector('span')?.textContent === board.labelsSectionTitle) as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    const input = container.querySelector<HTMLInputElement>(`input[data-slot="ds-input"][placeholder="${board.newLabelNamePlaceholder}"]`)!;
    await act(async () => { setInput(input, '긴급ㅂ'); });
    return input;
  }
  it('조합 중의 엔터는 라벨을 만들지 않고 기본 동작도 막지 않는다', async () => {
    const input = await openLabelName();
    let ev!: KeyboardEvent;
    await act(async () => { ev = key(input, 'Enter', { isComposing: true }); });
    await flush();
    expect(labelPosts()).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    expect(input.value).toBe('긴급ㅂ');
    await act(async () => { key(input, 'Enter', { keyCode: 229 }); });
    await flush();
    expect(labelPosts()).toEqual([]);
  });
  it('조합이 끝난 뒤의 엔터는 확정된 이름의 라벨을 한 번 만든다', async () => {
    const input = await openLabelName();
    await act(async () => { setInput(input, '긴급봉'); });
    await act(async () => { key(input, 'Enter'); });
    await flush();
    expect(labelPosts()).toEqual(['긴급봉']);
  });
});
