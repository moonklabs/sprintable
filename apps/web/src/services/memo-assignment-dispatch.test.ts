import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b20): 구현이 d64c4aaa("remove createAdminClient from memo-assignment-dispatch")로
// 대폭 단순화됨 — createTeamMemberRepository().getById(assigned_to) → member.webhook_url → fetch.
// webhook_configs 선호/createAdminClient/webhook_deliveries 경로는 제거(memo-event-dispatcher·
// webhook-notify로 이전·거기서 테스트). 구 테스트(webhook_configs 선호·console.error·db)는 stale →
// 현 계약(team-member webhook 직발송)으로 재작성. 회귀 아님(git 이력 확인).
const { createTeamMemberRepository } = vi.hoisted(() => ({
  createTeamMemberRepository: vi.fn(),
}));

vi.mock('@/lib/storage/factory', () => ({ createTeamMemberRepository }));

import { dispatchMemoAssignmentImmediately } from './memo-assignment-dispatch';

const baseMemo = {
  id: 'memo-1',
  org_id: 'org-1',
  project_id: 'proj-1',
  title: 'Test Memo',
  content: 'Please review',
  memo_type: 'task',
  status: 'open',
  assigned_to: 'agent-1',
  created_by: 'human-1',
  metadata: null,
  updated_at: '2026-04-22T00:00:00.000Z',
  created_at: '2026-04-22T00:00:00.000Z',
};

describe('dispatchMemoAssignmentImmediately', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('skips unassigned memos without resolving the repo', async () => {
    await dispatchMemoAssignmentImmediately({ ...baseMemo, assigned_to: null });
    expect(createTeamMemberRepository).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips non-open memos without resolving the repo', async () => {
    await dispatchMemoAssignmentImmediately({ ...baseMemo, status: 'resolved' });
    expect(createTeamMemberRepository).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends a webhook to the assigned team member webhook_url', async () => {
    createTeamMemberRepository.mockResolvedValue({
      getById: async () => ({ webhook_url: 'https://discord.com/api/webhooks/1/token' }),
    });

    await dispatchMemoAssignmentImmediately(baseMemo);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/1/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('skips fetch when the assigned member has no webhook_url', async () => {
    createTeamMemberRepository.mockResolvedValue({ getById: async () => ({ webhook_url: null }) });
    await dispatchMemoAssignmentImmediately(baseMemo);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips fetch when the assigned member is not found', async () => {
    createTeamMemberRepository.mockResolvedValue({ getById: async () => null });
    await dispatchMemoAssignmentImmediately(baseMemo);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('swallows repo/fetch errors (fire-and-forget) without throwing', async () => {
    createTeamMemberRepository.mockResolvedValue({ getById: async () => { throw new Error('repo down'); } });
    await expect(dispatchMemoAssignmentImmediately(baseMemo)).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
