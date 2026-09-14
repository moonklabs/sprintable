import { describe, expect, it } from 'vitest';
import { deriveWorkList, type WorkListInput } from './derive-work-list';

function page<T>(items: T[], hasMore: boolean | null = false) {
  return { items, hasMore };
}

function baseInput(overrides: Partial<WorkListInput> = {}): WorkListInput {
  return {
    goals: page([{ id: 'g1', title: '목표1', status: 'active' }]),
    stories: page([{ id: 's1', title: '스토리1', epic_id: 'g1' }]),
    tasks: page([]),
    agentRuns: [],
    inbox: [],
    teamMembers: [{ id: 'm-human', type: 'human', name: '사람' }, { id: 'm-agent', type: 'agent', name: '미르코' }],
    artifactCountByStoryId: new Map<string, number>(),
    hypotheses: [],
    ...overrides,
  };
}

describe('deriveWorkList — 목표/스토리 그룹핑', () => {
  it('일이 하나도 없는 목표는 groups에서 빠진다', () => {
    const result = deriveWorkList(baseInput());
    expect(result.groups).toHaveLength(0);
  });

  it('task가 있는 스토리만 goal 아래 남는다', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
    }));
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].goalId).toBe('g1');
    expect(result.groups[0].stories).toHaveLength(1);
    expect(result.groups[0].stories[0].storyId).toBe('s1');
    expect(result.groups[0].stories[0].rows).toHaveLength(1);
  });

  it('부모 스토리를 못 찾는 task/agent_run은 조용히 생략(짓지 않는다)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's-unknown', assignee_id: null, title: '할일1', status: 'todo' }]),
      agentRuns: [{ id: 'r1', story_id: 's-unknown', agent_id: 'a1', agent_name: '미르코', status: 'running' }],
    }));
    expect(result.groups).toHaveLength(0);
  });
});

describe('deriveWorkList — 행 상태: gates/inbox 우선, task.status 폴백', () => {
  it('inbox에 아무것도 없으면 task.status에서 폴백한다', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([
        { id: 't-todo', story_id: 's1', assignee_id: null, title: 'todo', status: 'todo' },
        { id: 't-doing', story_id: 's1', assignee_id: null, title: 'doing', status: 'in-progress' },
        { id: 't-done', story_id: 's1', assignee_id: null, title: 'done', status: 'done' },
      ]),
    }));
    const rows = result.groups[0].stories[0].rows;
    expect(rows.find((r) => r.id === 't-todo')?.state).toBeNull();
    expect(rows.find((r) => r.id === 't-doing')?.state).toBe('in_progress');
    expect(rows.find((r) => r.id === 't-done')?.state).toBe('done');
  });

  it('gate(risk=low)가 걸린 task → awaiting_approval, 저위험 칩 true', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'done' }]),
      inbox: [{ source: 'gate', id: 'gate1', work_item_id: 't1', work_item_type: 'task', status: 'pending', gate_type: 'merge', risk_grade: 'low' }],
    }));
    const row = result.groups[0].stories[0].rows[0];
    expect(row.state).toBe('awaiting_approval');
    expect(row.lowRisk).toBe(true);
  });

  it('gate(risk=high)가 걸린 task → awaiting_signature, 저위험 칩 false(같은 사실 두 낱말 금지)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
      inbox: [{ source: 'gate', id: 'gate1', work_item_id: 't1', work_item_type: 'task', status: 'pending', gate_type: 'merge', risk_grade: 'high' }],
    }));
    const row = result.groups[0].stories[0].rows[0];
    expect(row.state).toBe('awaiting_signature');
    expect(row.lowRisk).toBe(false);
  });

  it('gate_type=external_publish여도 risk=low면 awaiting_approval(카디르 계약값 ⑥, 페드루 판정 2026-09-14 10:55Z — gate_type은 더 이상 안 본다, deriveGateState는 risk_grade만의 함수)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
      inbox: [{ source: 'gate', id: 'gate1', work_item_id: 't1', work_item_type: 'task', status: 'pending', gate_type: 'external_publish', risk_grade: 'low' }],
    }));
    const row = result.groups[0].stories[0].rows[0];
    expect(row.state).toBe('awaiting_approval');
    expect(row.lowRisk).toBe(true);
  });

  it('gate(risk=null)가 걸린 task → awaiting_signature(카디르 계약값 ⑥ — null=unknown=고위험 취급, work-list-detail-panel.tsx의 primaryActionLabelKey와 같은 SSOT로 정정)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
      inbox: [{ source: 'gate', id: 'gate1', work_item_id: 't1', work_item_type: 'task', status: 'pending', gate_type: 'merge', risk_grade: null }],
    }));
    expect(result.groups[0].stories[0].rows[0].state).toBe('awaiting_signature');
  });

  it('hitl 항목(work_item_id=부모 story, BE 근거상 항상 story)이 걸린 task → awaiting_answer(task.status 무관)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'done' }]),
      inbox: [{ source: 'hitl', id: 'h1', work_item_id: 's1', status: 'pending', title: '질문', prompt: '이대로 진행할까요?' }],
    }));
    expect(result.groups[0].stories[0].rows[0].state).toBe('awaiting_answer');
  });

  it('resolved(status!=pending) inbox 항목은 무시하고 task.status로 폴백', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'in-progress' }]),
      inbox: [{ source: 'gate', id: 'gate1', work_item_id: 't1', work_item_type: 'task', status: 'approved', gate_type: 'merge', risk_grade: 'high' }],
    }));
    expect(result.groups[0].stories[0].rows[0].state).toBe('in_progress');
  });

  it('⭐DB CHECK 제약 실측 — task.status는 하이픈 in-progress(언더스코어 아님), 틀린 철자는 진행 중으로 안 잡는다', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'in_progress' }]),
    }));
    expect(result.groups[0].stories[0].rows[0].state).toBeNull();
  });

  it('task 자체엔 gate가 없지만 부모 story에 걸려있으면 그걸 따른다', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
      inbox: [{ source: 'gate', id: 'gate1', work_item_id: 's1', work_item_type: 'story', status: 'pending', gate_type: 'merge', risk_grade: 'high' }],
    }));
    expect(result.groups[0].stories[0].rows[0].state).toBe('awaiting_signature');
  });
});

describe('deriveWorkList — agent_run 행', () => {
  it('agent_run 행 제목은 부모 story.title 재사용(today_service.py 선례)', () => {
    const result = deriveWorkList(baseInput({
      agentRuns: [{ id: 'r1', story_id: 's1', agent_id: 'a1', agent_name: '미르코', status: 'running' }],
    }));
    const row = result.groups[0].stories[0].rows[0];
    expect(row.kind).toBe('agent_run');
    expect(row.title).toBe('스토리1');
    expect(row.ownerName).toBe('미르코');
    expect(row.isDelegated).toBe(true);
  });

  it('agent_run.status: queued/held/running/hitl_pending=in_progress, completed=done, failed/abandoned=null', () => {
    const statuses: Array<[string, string | null]> = [
      ['queued', 'in_progress'], ['held', 'in_progress'], ['running', 'in_progress'], ['hitl_pending', 'in_progress'],
      ['completed', 'done'], ['failed', null], ['abandoned', null],
    ];
    for (const [status, expected] of statuses) {
      const result = deriveWorkList(baseInput({
        agentRuns: [{ id: `r-${status}`, story_id: 's1', agent_id: 'a1', agent_name: null, status }],
      }));
      expect(result.groups[0].stories[0].rows[0].state).toBe(expected);
    }
  });

  it('story에 걸린 pending inbox 항목이 agent_run.status보다 우선한다', () => {
    const result = deriveWorkList(baseInput({
      agentRuns: [{ id: 'r1', story_id: 's1', agent_id: 'a1', agent_name: '미르코', status: 'running' }],
      inbox: [{ source: 'hitl', id: 'h1', work_item_id: 's1', status: 'pending', title: '질문', prompt: '?' }],
    }));
    expect(result.groups[0].stories[0].rows[0].state).toBe('awaiting_answer');
  });
});

describe('deriveWorkList — 배정/위임(team_members 교차대조)', () => {
  it('assignee_id가 human 타입이면 isDelegated=false', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: 'm-human', title: '할일1', status: 'todo' }]),
    }));
    expect(result.groups[0].stories[0].rows[0].isDelegated).toBe(false);
  });

  it('assignee_id가 agent 타입이면 isDelegated=true', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: 'm-agent', title: '할일1', status: 'todo' }]),
    }));
    expect(result.groups[0].stories[0].rows[0].isDelegated).toBe(true);
  });

  it('assignee_id가 null이거나 team_members에 없으면 isDelegated=false(지어내지 않는다)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([
        { id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' },
        { id: 't2', story_id: 's1', assignee_id: 'm-unknown', title: '할일2', status: 'todo' },
      ]),
    }));
    const rows = result.groups[0].stories[0].rows;
    expect(rows.every((r) => r.isDelegated === false)).toBe(true);
  });

  it('ownerName은 위임 행뿐 아니라 사람 배정 행도 team_members 이름으로 채운다(PO 지적)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: 'm-human', title: '할일1', status: 'todo' }]),
    }));
    expect(result.groups[0].stories[0].rows[0].ownerName).toBe('사람');
  });

  it('assignee_id가 없거나 이름 없는 멤버면 ownerName=null(지어내지 않는다)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
    }));
    expect(result.groups[0].stories[0].rows[0].ownerName).toBeNull();
  });
});

describe('deriveWorkList — 목표 헤더 집계(일 단위, PO 確定)', () => {
  it('doneCount/totalCount는 task+agent_run 합산 일 단위(스토리 단위 아님)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([
        { id: 't1', story_id: 's1', assignee_id: 'm-human', title: 'a', status: 'done' },
        { id: 't2', story_id: 's1', assignee_id: 'm-agent', title: 'b', status: 'todo' },
      ]),
      agentRuns: [{ id: 'r1', story_id: 's1', agent_id: 'a1', agent_name: null, status: 'completed' }],
    }));
    const group = result.groups[0];
    expect(group.totalCount).toBe(3);
    expect(group.doneCount).toBe(2);
    expect(group.assignedCount).toBe(1);
    expect(group.delegatedCount).toBe(2); // t2(agent) + r1(agent_run은 항상 위임)
  });

  it('hypothesisCount는 그 목표 아래 스토리들의 hypothesisIds 합집합 크기(중복 제거)', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: 'a', status: 'todo' }]),
      hypotheses: [
        { id: 'h1', statement: '가설1', epic_ids: ['g1'], story_ids: [] },
        { id: 'h2', statement: '가설2', epic_ids: [], story_ids: ['s1'] },
      ],
    }));
    expect(result.groups[0].hypothesisCount).toBe(2);
  });

  it('isActive는 GoalStatus===\'active\'일 때만 true(PO 지적 — 「진행 중」 낱말은 데이터 없으면 지어내지 않는다)', () => {
    const active = deriveWorkList(baseInput({
      goals: page([{ id: 'g1', title: '목표1', status: 'active' }]),
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: 'a', status: 'todo' }]),
    }));
    expect(active.groups[0].isActive).toBe(true);

    const done = deriveWorkList(baseInput({
      goals: page([{ id: 'g1', title: '목표1', status: 'done' }]),
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: 'a', status: 'todo' }]),
    }));
    expect(done.groups[0].isActive).toBe(false);
  });
});

describe('deriveWorkList — 산출물 칩(story_id별 실 개수, PO 지적 — 있음/없음 아니라 개수)', () => {
  it('artifactCountByStoryId에 있는 story의 행은 그 개수를 그대로 옮긴다', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
      artifactCountByStoryId: new Map([['s1', 3]]),
    }));
    expect(result.groups[0].stories[0].rows[0].artifactCount).toBe(3);
  });

  it('없으면 artifactCount=0', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
    }));
    expect(result.groups[0].stories[0].rows[0].artifactCount).toBe(0);
  });
});

describe('deriveWorkList — partial(더 있음, 「없다」 단정 금지)', () => {
  it('전 소스 hasMore=false면 partial=false', () => {
    const result = deriveWorkList(baseInput());
    expect(result.partial).toBe(false);
  });

  it('goals.hasMore=true면 partial=true', () => {
    const result = deriveWorkList(baseInput({ goals: page([{ id: 'g1', title: '목표1', status: 'active' }], true) }));
    expect(result.partial).toBe(true);
  });

  it('tasks.hasMore=null(모름)이면 partial=true(모르면 단정 안 함)', () => {
    const result = deriveWorkList(baseInput({ tasks: page([], null) }));
    expect(result.partial).toBe(true);
  });

  it('agent_run/inbox는 페이지네이션 없는 계약이라 partial 판정에 안 들어간다', () => {
    const result = deriveWorkList(baseInput({
      agentRuns: [{ id: 'r1', story_id: 's1', agent_id: 'a1', agent_name: null, status: 'running' }],
      inbox: [{ source: 'gate', id: 'gate1', work_item_id: 's1', work_item_type: 'story', status: 'pending', gate_type: 'merge', risk_grade: 'low' }],
    }));
    expect(result.partial).toBe(false);
  });
});

describe('deriveWorkList — 가설 연결(hypothesisIds, 필터 재료)', () => {
  it('story_ids에 직접 있으면 매치', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
      hypotheses: [{ id: 'h1', statement: '가설1', epic_ids: [], story_ids: ['s1'] }],
    }));
    expect(result.groups[0].stories[0].hypothesisIds).toEqual(['h1']);
  });

  it('부모 goal의 epic_ids에 있으면 상속으로 매치', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
      hypotheses: [{ id: 'h1', statement: '가설1', epic_ids: ['g1'], story_ids: [] }],
    }));
    expect(result.groups[0].stories[0].hypothesisIds).toEqual(['h1']);
  });

  it('연결 없으면 빈 배열', () => {
    const result = deriveWorkList(baseInput({
      tasks: page([{ id: 't1', story_id: 's1', assignee_id: null, title: '할일1', status: 'todo' }]),
    }));
    expect(result.groups[0].stories[0].hypothesisIds).toEqual([]);
  });
});
