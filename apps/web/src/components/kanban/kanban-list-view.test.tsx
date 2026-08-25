// story #3050(2984-S2, 유나 design PASS 비차단 finding) — 그룹 헤더 카운트 pill이
// CountBadge(S1, mono+엠보스 inset)를 쓰고 옛 bg-muted 채움은 안 쓴다.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { KanbanListView } from './kanban-list-view';
import koMessages from '../../../messages/ko.json';
import type { KanbanStory } from './types';

function story(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', title: 'Story', status: 'backlog', story_points: null,
    ...overrides,
  } as KanbanStory;
}

describe('KanbanListView — story #3050 그룹 헤더 카운트 pill', () => {
  it('CountBadge(mono+엠보스 inset)를 쓰고 bg-muted 채움은 안 쓴다', () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <KanbanListView
          stories={[story({ status: 'backlog' })]}
          epicMap={{}}
          memberMap={{}}
          onStoryClick={() => {}}
          onChangeStatus={async () => {}}
        />
      </NextIntlClientProvider>,
    );
    expect(markup).toContain('font-mono');
    expect(markup).toContain('shadow-[var(--elev-inset)]');
    expect(markup).not.toContain('rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground');
  });
});
