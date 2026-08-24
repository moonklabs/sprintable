import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import { StoryCard } from './story-card';
import type { KanbanStory, KanbanMember } from './types';

function makeStory(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'in-progress', priority: 'medium',
    story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null,
    ...overrides,
  };
}

function render(story: KanbanStory, assignees: KanbanMember[] = []) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <DndContext>
        <StoryCard story={story} assignees={assignees} onClick={() => {}} />
      </DndContext>
    </NextIntlClientProvider>,
  );
}

// story #2993 로드맵 PR-A(L1) — 컨텍스트/상태 서브메뉴 floating 팝업은 --elev-overlay
// 토큰이어야 한다(L1: overlay=floating 전용). shadow-md 리터럴 회귀가드.
describe('StoryCard — 로드맵 PR-A L1(floating 팝업 elev-overlay)', () => {
  it('상시 마크업에 shadow-md 리터럴이 없다(컨텍스트메뉴는 열렸을 때만 렌더되므로 정적 렌더로는 부재 확인)', () => {
    const markup = render(makeStory());
    expect(markup).not.toContain('shadow-md');
  });
});

// story #2993 로드맵 PR-A(L5) — agent 정적 아바타 테두리는 citron(live pulse 전용)이 아니라
// proof-blue(정체성 마킹, avatar.tsx idle 링과 정합)여야 한다.
describe('StoryCard — 로드맵 PR-A L5(agent 아바타 정적 identity=proof-blue)', () => {
  it('agent assignee 아바타가 border-proof-blue/bg-proof-blue-soft를 쓰고 citron은 안 쓴다', () => {
    const markup = render(makeStory(), [{ id: 'a1', name: '에이전트군', type: 'agent' }]);
    expect(markup).toContain('border-proof-blue/30');
    expect(markup).toContain('bg-proof-blue-soft');
    expect(markup).not.toContain('border-accent-claim');
    expect(markup).not.toContain('bg-accent-claim/10');
  });

  it('human assignee 아바타는 무변화(border-border/bg-muted 그대로)', () => {
    const markup = render(makeStory(), [{ id: 'h1', name: '책임자', type: 'human' }]);
    expect(markup).toContain('border-border');
    expect(markup).toContain('bg-muted');
  });
});
