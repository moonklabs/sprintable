import { beforeEach, describe, expect, it, vi } from 'vitest';

// codex-silent-defect-sweep F-7 — internal-dogfood-sprintable.test.ts는
// dispatchMemoAssignmentImmediately를 통째로 mock(vi.fn(async () => undefined))해
// "호출됐는지"만 확認한다. 그 mock이 실제 구현이 no-op이 돼도 통과라, memo는 보이지만
// 배정된 agent 실행(웹훅 발송)이 시작하지 않는 결함을 이 테스트 하나로는 못 잡는다.
//
// 이 파일은 dispatchMemoAssignmentImmediately를 mock하지 않고 실제 구현을 그대로 태워
// (그 아래 의존성 createTeamMemberRepository·fetch만 mock), memo 생성 → 실 배정 dispatch →
// 실제 웹훅 POST까지 전 구간이 이어져 있는지 증명한다. 기존 파일(호출-형태 계약)과
// 이 파일(실 전달 효과)이 함께 있어야 F-7이 지적한 갭이 닫힌다.
const { createTeamMemberRepository } = vi.hoisted(() => ({
  createTeamMemberRepository: vi.fn(),
}));

vi.mock('@/lib/storage/factory', () => ({ createTeamMemberRepository }));

import { createInternalDogfoodMemoInSprintable } from './internal-dogfood-sprintable';

function makeDb(memoRow: Record<string, unknown>) {
  return {
    from(table: string) {
      if (table === 'memos') {
        const builder = {
          insert() { return builder; },
          select() { return builder; },
          single: async () => ({ data: memoRow, error: null }),
        };
        return builder;
      }
      throw new Error(`Unexpected table read: ${table}`);
    },
  } as unknown as never;
}

describe('createInternalDogfoodMemoInSprintable — 실 dispatch 효과(codex-silent-defect-sweep F-7)', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('배정된 memo 생성이 실제로 담당자 webhook_url에 POST를 보낸다(dispatcher no-op이면 이 테스트가 실패한다)', async () => {
    createTeamMemberRepository.mockResolvedValue({
      getById: async (id: string) => (
        id === 'agent-1' ? { webhook_url: 'https://discord.com/api/webhooks/1/token' } : null
      ),
    });

    const memoRow = {
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Internal blocker',
      content: 'memo body',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'tm-1',
      metadata: { internal_dogfood: true },
      updated_at: '2026-04-10T10:00:00.000Z',
      created_at: '2026-04-10T10:00:00.000Z',
    };

    await createInternalDogfoodMemoInSprintable(
      makeDb(memoRow),
      { id: 'tm-1', org_id: 'org-1', project_id: 'project-1', name: 'Didi', project_name: 'Sprintable' },
      { title: 'Internal blocker', content: 'memo body', memoType: 'task', assignedTo: 'agent-1' },
    );

    expect(createTeamMemberRepository).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/1/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('미배정 memo는 dispatcher 내부에서 조기 반환돼 webhook 조회조차 하지 않는다(회귀 0)', async () => {
    const memoRow = {
      id: 'memo-2',
      org_id: 'org-1',
      project_id: 'project-1',
      title: null,
      content: 'unassigned memo',
      memo_type: 'task',
      status: 'open',
      assigned_to: null,
      created_by: 'tm-1',
      metadata: { internal_dogfood: true },
      updated_at: '2026-04-10T10:00:00.000Z',
      created_at: '2026-04-10T10:00:00.000Z',
    };

    await createInternalDogfoodMemoInSprintable(
      makeDb(memoRow),
      { id: 'tm-1', org_id: 'org-1', project_id: 'project-1', name: 'Didi', project_name: 'Sprintable' },
      { title: undefined, content: 'unassigned memo', memoType: 'task', assignedTo: null },
    );

    expect(createTeamMemberRepository).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
