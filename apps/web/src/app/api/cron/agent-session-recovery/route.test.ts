import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createClientMock,
  recoverStaleRunsMock,
  resumeSessionCandidatesMock,
} = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  recoverStaleRunsMock: vi.fn(),
  resumeSessionCandidatesMock: vi.fn(),
}));

vi.mock('', () => ({
  createClient: createClientMock,
}));

vi.mock('@/services/agent-session-lifecycle', () => ({
  AgentSessionLifecycleService: class {
    recoverStaleRuns = recoverStaleRunsMock;
  },
}));

vi.mock('@/services/agent-session-resume', () => ({
  resumeSessionCandidates: resumeSessionCandidatesMock,
}));

import { GET } from './route';

describe('GET /api/cron/agent-session-recovery', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    createClientMock.mockReset();
    recoverStaleRunsMock.mockReset();
    resumeSessionCandidatesMock.mockReset();
    createClientMock.mockReturnValue({ tag: 'supabase' });
    recoverStaleRunsMock.mockResolvedValue({
      recoveredCount: 1,
      retryScheduledCount: 1,
      terminatedCount: 0,
      resumedCount: 1,
      resumeCandidates: [{ runId: 'run-1', memoId: 'memo-1', orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' }],
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('runs session recovery when the cron secret matches', async () => {
    const response = await GET(new Request('http://localhost:3108/api/cron/agent-session-recovery', {
      headers: { authorization: 'Bearer cron-secret' },
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith('https://supabase.example.com', 'service-role-key');
    expect(recoverStaleRunsMock).toHaveBeenCalledTimes(1);
    expect(resumeSessionCandidatesMock).toHaveBeenCalledWith({ tag: 'supabase' }, [
      { runId: 'run-1', memoId: 'memo-1', orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' },
    ]);
    expect(payload.data).toEqual({ recoveredCount: 1, retryScheduledCount: 1, terminatedCount: 0, resumedCount: 1 });
  });
});
