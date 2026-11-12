// @vitest-environment jsdom
//
// [SID:4345] 스토리 카드 액션 묶음(규칙 실행 표시 · 킥오프)은 `sm:opacity-0 sm:group-hover:opacity-100` — 숨김 기준이 폭(640)이라
// 640 이상 터치 태블릿에서 늘 투명했다. 이제 기준은 «호버가 되는가»(HOVER_REVEAL · pointer-fine)다. 킥오프 버튼엔 초점 링.
// jsdom은 CSS를 안 입혀서 보임 여부는 클래스 모양으로 핀한다.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING } from '@/lib/hover-reveal';
import { StoryCard } from './story-card';
import type { KanbanStory } from './types';

const story: KanbanStory = {
  id: 's1', story_number: 1, title: 'Story', status: 'in-progress', priority: 'medium',
  story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
  description: null, acceptance_criteria: null, attachments: null, position: null,
  success_hypothesis: null, metric_definition: null, measure_after: null,
  outcome_status: 'n_a', outcome_result: null,
};

// 4908 — 카드 호버 로켓(킥오프)은 «⋯» 메뉴로 옮겨 갔다. 4345 규칙(호버 전용 아님)은 그 자리의 조작 요소인 «⋯» 버튼이 이어받는다.
function menuButton() {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <DndContext>
        <StoryCard story={story} onClick={() => {}} projectId="p1" />
      </DndContext>
    </NextIntlClientProvider>,
  );
  return host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
}

describe('StoryCard «⋯» 버튼 — 호버 전용 아님([SID:4345] → 4908)', () => {
  it('HOVER_REVEAL(폭 기준 sm: 숨김 0) · 초점 링 · 누르는 자리 24×24(터치 44×44)', () => {
    const button = menuButton();
    const tokens = button.className.split(/\s+/);
    for (const t of HOVER_REVEAL.split(' ')) expect(tokens, t).toContain(t);
    expect(tokens.filter((t) => /^(sm|md|lg|xl):(opacity-0|group-hover:opacity-100)$/.test(t))).toEqual([]);
    expect(tokens).not.toContain('opacity-0');
    for (const t of HOVER_REVEAL_FOCUS_RING.split(' ')) expect(tokens, t).toContain(t);
    expect(tokens).toEqual(expect.arrayContaining(['size-6', 'min-h-6', 'min-w-6', 'touch:size-11']));
  });
});
