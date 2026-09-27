// @vitest-environment jsdom
//
// [SID:4362 AC2] 390 스토리 패널 제목 — 디자인 Button 기본이 whitespace-nowrap이라 제목 h2가 한 줄로 패널 밖까지 늘었다(390에서 525px ·
// 키보드 초점 링도 패널 밖 = 유나 «초록 테두리가 패널 밖»). 줄바꿈 허용 · 긴 낱말(경로 · URL)도 꺾음을 못박는다(실제 폭은 헤드리스 판).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human' }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const story: KanbanStory = {
  id: 's1', story_number: 4362, title: 'apps/web/src/components/kanban/story-detail-panel.tsx 제목이 긴 스토리', status: 'backlog', priority: 'medium',
  story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
  description: null, acceptance_criteria: null, attachments: [], position: null,
  success_hypothesis: null, metric_definition: null, measure_after: null, outcome_status: 'n_a', outcome_result: null,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // 목록을 배열로 읽는 곳(거절된 관계 · 라벨 · 항목 라벨)은 배열로, 나머지는 { data: [] }.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => (/rejected-relations|\/api\/labels|\/api\/item-labels/.test(String(url)) ? [] : { data: [] }) })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('스토리 패널 제목 — 좁은 폭에서 줄바꿈([SID:4362 AC2])', () => {
  it('제목 버튼 whitespace-normal(디자인 Button 기본 nowrap 덮음) · h2 min-w-0 · [overflow-wrap:anywhere] · 버튼 w-full min-w-0 그대로', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ToastProvider><StoryDetailPanel story={story} tasks={[]} onClose={() => {}} /></ToastProvider>
        </NextIntlClientProvider>,
      );
    });
    const h2 = container.querySelector('h2')!;
    expect(h2.textContent).toBe(story.title);
    const btn = h2.closest('button')!;
    const c = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);
    expect(c(btn)).toEqual(expect.arrayContaining(['whitespace-normal', 'w-full', 'min-w-0']));
    expect(c(btn)).not.toContain('whitespace-nowrap');
    expect(c(h2)).toEqual(expect.arrayContaining(['min-w-0', '[overflow-wrap:anywhere]']));
  });
});

// PO 18:11Z 전수 — 같은 부류(디자인 Button 기본 nowrap × 사용자 글): 담당자 고르개 줄의 긴 구성원 이름이 줄 밖으로 넘쳤다(390 실측 글 483px · 줄 338px).
describe('담당자 고르개 줄 — 긴 구성원 이름 줄바꿈([SID:4362])', () => {
  it('줄 버튼 whitespace-normal · 이름 칸 min-w-0 flex-1 [overflow-wrap:anywhere] · ✓는 shrink-0', async () => {
    const members = [{ id: 'm1', name: '아주 긴 이름을 가진 에이전트 — 모바일 네이티브 셸 엔지니어', type: 'agent' }] as never;
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ToastProvider><StoryDetailPanel story={{ ...story, assignee_id: 'm1', assignee_ids: ['m1'] } as KanbanStory} tasks={[]} onClose={() => {}} members={members} memberMap={{ m1: (members as unknown as unknown[])[0] } as never} /></ToastProvider>
        </NextIntlClientProvider>,
      );
    });
    const edit = [...container.querySelectorAll('button')].filter((b) => /✎/.test(b.textContent ?? ''))
      .find((b) => b.closest('div')?.parentElement?.textContent?.includes(koMessages.board.assignee))!;
    await act(async () => { edit.click(); });
    const name = container.querySelector('[data-assignee-name]')!;
    expect(name.textContent).toContain('아주 긴 이름');
    const c = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);
    expect(c(name)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', '[overflow-wrap:anywhere]']));
    const row = name.closest('button')!;
    expect(c(row)).toContain('whitespace-normal');
    expect(c(row)).not.toContain('whitespace-nowrap');
  });
});

