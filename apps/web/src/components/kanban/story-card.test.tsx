import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import type { ReactElement } from 'react';
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

// story #2998 로드맵 PR-A(L1) — 컨텍스트/상태 서브메뉴 floating 팝업은 --elev-overlay
// 토큰이어야 한다(L1: overlay=floating 전용). shadow-md 리터럴 회귀가드.
describe('StoryCard — 로드맵 PR-A L1(floating 팝업 elev-overlay)', () => {
  it('상시 마크업에 shadow-md 리터럴이 없다(컨텍스트메뉴는 열렸을 때만 렌더되므로 정적 렌더로는 부재 확인)', () => {
    const markup = render(makeStory());
    expect(markup).not.toContain('shadow-md');
  });
});

// story #3049(2984-S1) — agent 정적 아바타 테두리는 proof-blue(정체성 마킹, avatar.tsx idle
// 링과 정합)를 유지하되, 배경 soft-fill은 폐지(AGENT_MARK_FILL_CLASS=투명, 헤어라인만 남김).
describe('StoryCard — story #3049(agent 아바타 헤어라인, soft-fill 폐지)', () => {
  it('agent assignee 아바타가 border-proof-blue를 쓰고 soft-fill/citron은 안 쓴다', () => {
    const markup = render(makeStory(), [{ id: 'a1', name: '에이전트군', type: 'agent' }]);
    expect(markup).toContain('border-proof-blue/30');
    expect(markup).not.toContain('bg-proof-blue-soft');
    expect(markup).not.toContain('border-accent-claim');
    expect(markup).not.toContain('bg-accent-claim/10');
  });

  it('human assignee 아바타는 무변화(border-border/bg-muted 그대로)', () => {
    const markup = render(makeStory(), [{ id: 'h1', name: '책임자', type: 'human' }]);
    expect(markup).toContain('border-border');
    expect(markup).toContain('bg-muted');
  });
});

// story #32dcc294(v2 #2, 시안 a230cfd5) — 보드 스토리 카드 3층 재설계 회귀가드. 카테고리 칩+
// 제목 lead 2줄 클램프+「다음 액션」1급 라인. 위 render()/makeStory() 헬퍼와 이름이 겹치지
// 않게 renderKo()/story()로 새로 둔다(기존 헬퍼는 그대로 재사용 가능해도 이 블록은 독립).
function renderKo(ui: ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <DndContext>{ui}</DndContext>
    </NextIntlClientProvider>,
  );
}

function story(overrides: Partial<KanbanStory>): KanbanStory {
  return {
    id: 's1',
    title: '테스트 스토리',
    status: 'backlog',
    priority: 'medium',
    story_points: null,
    epic_id: null,
    assignee_id: null,
    assignee_ids: [],
    ...overrides,
  } as KanbanStory;
}

describe('StoryCard — story #32dcc294 제목 파싱(카테고리 칩+lead)', () => {
  it('선두 [태그]가 카테고리 칩으로 분리되고, claim(line-clamp-2 제목)에는 태그 원문이 남지 않는다', () => {
    const markup = renderKo(
      <StoryCard story={story({ title: '[Workcell·콘텐츠 ③] goal/DoD 구조화 소스 트랙' })} onClick={() => {}} />,
    );
    expect(markup).toContain('Workcell·콘텐츠 ③');
    // claim(line-clamp-2) div는 lead만 담는다 — 카드 바깥 title 툴팁 속성은 접근성상 원문
    // 전체를 보존해야 하므로(별개 관심사) 거기까지 검사 범위를 넓히지 않는다.
    const claimMatch = markup.match(/class="mt-1\.5 line-clamp-2 text-\[12\.5px\] font-semibold leading-snug text-proof-ink">([^<]*)</);
    expect(claimMatch).toBeTruthy();
    expect(claimMatch![1]).toBe('goal/DoD 구조화 소스 트랙');
  });

  it('[태그] 없는 제목은 훼손 없이 verbatim 그대로 렌더된다(카테고리 칩 없음)', () => {
    const markup = renderKo(<StoryCard story={story({ title: '태그 없는 평범한 제목' })} onClick={() => {}} />);
    expect(markup).toContain('태그 없는 평범한 제목');
  });

  // story #3050(2984-S2) — 카테고리 칩은 MaterialChip(S1, 헤어라인+fill 0)을 쓴다. 옛
  // bg-muted 채움은 폐지.
  it('story #3050 — 카테고리 칩이 MaterialChip(헤어라인)을 쓰고 bg-muted 채움은 안 쓴다', () => {
    const markup = renderKo(
      <StoryCard story={story({ title: '[Workcell·콘텐츠 ③] goal/DoD 구조화 소스 트랙' })} onClick={() => {}} />,
    );
    expect(markup).toContain('border-proof-line');
    expect(markup).toContain('bg-transparent');
    expect(markup).not.toContain('bg-muted px-1.5');
  });

  it('story_number가 있으면 #번호가 별도 배지로 렌더되고, 더 이상 제목 문자열에 접두되지 않는다', () => {
    const markup = renderKo(<StoryCard story={story({ title: '번호배지 테스트', story_number: 3018 })} onClick={() => {}} />);
    expect(markup).toContain('#3018');
    expect(markup).not.toContain('#3018 번호배지 테스트');
  });

  it('story_number가 없으면 번호 배지 자체를 렌더하지 않는다(지어내지 않음)', () => {
    const markup = renderKo(<StoryCard story={story({ title: '번호없음', story_number: null })} onClick={() => {}} />);
    expect(markup).not.toMatch(/#\d/);
  });
});

describe('StoryCard — story #32dcc294 「다음: …」1급 라인(boy-scout 절제·기존 신호 재배치)', () => {
  it('의존 스토리에 막혀 있으면(status!=done) 「다음: {blockedBy 문구}」가 뜬다', () => {
    const markup = renderKo(
      <StoryCard story={story({ title: '차단카드', status: 'backlog' })} onClick={() => {}} blockedBy={['dep-1']} />,
    );
    expect(markup).toContain('다음:');
    expect(markup).toContain('1개에 의해 차단됨');
  });

  it('done 상태면 blockedBy가 있어도 「다음: …」이 뜨지 않는다(기존 규칙 그대로 재배치)', () => {
    const markup = renderKo(
      <StoryCard story={story({ title: '완료카드', status: 'done' })} onClick={() => {}} blockedBy={['dep-1']} />,
    );
    expect(markup).not.toContain('다음:');
  });

  it('pending gate가 있으면 「다음: {gate_type} 게이트 대기중}」이 뜨고, meta row엔 중복 배지가 없다', () => {
    const markup = renderKo(
      <StoryCard
        story={story({ title: '게이트카드', status: 'in-review' })}
        onClick={() => {}}
        gates={[{ id: 'g1', gate_type: 'merge', status: 'pending' }]}
      />,
    );
    expect(markup).toContain('다음:');
    // meta row에는 더 이상 pending_gate Badge가 안 뜬다(1급 라인으로 승격돼 중복 제거) —
    // "merge 게이트 대기" 문구가 정확히 1회만 등장해야 한다(2회면 meta row 중복 잔존).
    const occurrences = markup.split('merge 게이트 대기').length - 1;
    expect(occurrences).toBe(1);
  });

  it('handoff_stuck 신호가 있으면 「다음: …」이 뜨고 meta row 중복 배지가 없다', () => {
    const markup = renderKo(
      <StoryCard
        story={story({ title: '핸드오프카드', status: 'in-progress' })}
        onClick={() => {}}
        lineStatus={{ story_id: 's1', has_active: true, mode: null, status: null, engine_degraded: false, grandfathered: false, handoff_stuck: true, delivery_status: 'timed_out' }}
      />,
    );
    expect(markup).toContain('다음:');
  });

  it('행동 필요 신호가 전혀 없으면 「다음: …」 라인 자체를 렌더하지 않는다(정직 — 없으면 미표시)', () => {
    const markup = renderKo(<StoryCard story={story({ title: '평범카드' })} onClick={() => {}} />);
    expect(markup).not.toContain('다음:');
  });

  it('engine_degraded(정보성)는 승격 대상이 아니다 — 「다음: …」 없이 기존 meta 배지 자리에 그대로 남는다', () => {
    const markup = renderKo(
      <StoryCard
        story={story({ title: '엔진저하카드' })}
        onClick={() => {}}
        lineStatus={{ story_id: 's1', has_active: true, mode: null, status: null, engine_degraded: true, grandfathered: false, handoff_stuck: false, delivery_status: null }}
      />,
    );
    expect(markup).not.toContain('다음:');
  });
});
