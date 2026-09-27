// @vitest-environment jsdom
//
// [SID:4367] 한 Esc = 한 층 — 설명/AC 편집 중 `#` 엔티티 후보를 Esc로 닫으면 편집까지 취소돼 방금 쓴 글이 버려졌다(입력칸 Esc가
// 표시 없이 흘러 패널 window Esc가 «편집 중이면 취소 · 초안을 원래 값으로»까지 함 · 실 브라우저 판 · 배포 36과 같은 소스).
// 이제: 첫 Esc = 후보만 닫힘(편집 · 쓴 글 그대로) · 둘째 Esc = 편집 취소(설계대로) · 셋째 Esc = 패널 닫힘. 안쪽이 preventDefault한 Esc는
// 패널이 건너뛴다(산출물 댓글 쓰기 칸 · 포털 메뉴 같은 안쪽 층 공통).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const story = {
  id: 's1', story_number: 1, title: '한 Esc 한 층', status: 'backlog', priority: 'medium', story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
  description: '원래 설명', acceptance_criteria: '원래 AC', attachments: null, position: null, success_hypothesis: null, metric_definition: null, measure_after: null,
  outcome_status: 'n_a', outcome_result: null,
} as KanbanStory;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/entities/search')) {
      return new Response(JSON.stringify({ data: { data: [{ entity_type: 'story', entity_id: 'x1', title: '회의록 정리', status: null }], types: [] } }), { status: 200 });
    }
    return { ok: false, json: async () => null } as unknown as Response;
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(onClose: () => void) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider><StoryDetailPanel story={story} tasks={[]} projectId="p1" onClose={onClose} /></ToastProvider>
      </NextIntlClientProvider>,
    );
  });
}
const esc = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const editorOf = (orig: string) => [...container.querySelectorAll('textarea')].find((t) => t.value.startsWith(orig)) ?? null;

describe('StoryDetailPanel — 편집 중 후보 Esc는 후보만([SID:4367])', () => {
  for (const [name, orig, label] of [['설명', '원래 설명', koMessages.board.description], ['AC', '원래 AC', koMessages.board.acceptanceCriteria]] as const) {
    it(`${name} 편집 중 후보 열고 Esc → 후보만 닫힘 · 쓴 글 그대로 → Esc → 편집 취소 → Esc → 패널 닫힘`, async () => {
      const onClose = vi.fn();
      await mount(onClose);
      // 그 칸 머리(«설명» · «완료 조건» 글자)와 같은 줄의 ✎ 버튼(차례를 세지 않고 머리 글자로 짚는다).
      const head = [...container.querySelectorAll('span')].find((x) => x.textContent === label)!;
      const edit = [...head.parentElement!.querySelectorAll('button')].find((x) => /✎/.test(x.textContent ?? ''))!;
      await act(async () => { edit.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const el = editorOf(orig)!;
      expect(el).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      const typed = `${orig} 중요한 새 문장 #회`;
      await act(async () => {
        setter.call(el, typed);
        el.selectionStart = typed.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
      expect(document.querySelector('[data-dropdown-panel="entity-candidates"]')).not.toBeNull();

      await act(async () => { esc(el); });
      expect(document.querySelector('[data-dropdown-panel="entity-candidates"]')).toBeNull();
      expect(editorOf(orig)?.value).toBe(typed);
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => { esc(editorOf(orig)!); });
      expect(editorOf(orig)).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => { esc(document.body); });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  }

  it('안쪽 층이 preventDefault한 Esc는 패널이 건너뜀 · 표시 없는 Esc는 닫힘', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    const inner = container.querySelector('button')!;
    const mark = (e: Event) => e.preventDefault();
    inner.addEventListener('keydown', mark);
    await act(async () => { esc(inner); });
    expect(onClose).not.toHaveBeenCalled();
    inner.removeEventListener('keydown', mark);
    await act(async () => { esc(inner); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
