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
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
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
