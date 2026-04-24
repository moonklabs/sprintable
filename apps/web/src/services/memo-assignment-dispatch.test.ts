import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseAdminClient } = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));

vi.mock('@/lib/storage/factory', () => ({
  isOssMode: vi.fn(() => false),
  createTeamMemberRepository: vi.fn(),
}));

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

function makeSupabase(results: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'webhook_deliveries') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'delivery-1' }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        };
      }
      const payload = results[table] ?? { data: null, error: null };
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue(payload),
      };
    }),
  };
}

describe('dispatchMemoAssignmentImmediately', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('skips unassigned memos without calling supabase', async () => {
    await dispatchMemoAssignmentImmediately({ ...baseMemo, assigned_to: null });
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips non-open memos without calling supabase', async () => {
    await dispatchMemoAssignmentImmediately({ ...baseMemo, status: 'resolved' });
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends webhook via team_members.webhook_url when webhook_configs is empty', async () => {
    const supabase = makeSupabase({
      webhook_configs: { data: null, error: null },
      team_members: { data: { webhook_url: 'https://discord.com/api/webhooks/1/token' }, error: null },
    });
    createSupabaseAdminClient.mockReturnValue(supabase);

    await dispatchMemoAssignmentImmediately(baseMemo);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/1/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('prefers webhook_configs url over team_members.webhook_url', async () => {
    const supabase = makeSupabase({
      webhook_configs: { data: { id: 'config-1', url: 'https://discord.com/api/webhooks/2/config', secret: null }, error: null },
      team_members: { data: { webhook_url: 'https://discord.com/api/webhooks/1/fallback' }, error: null },
    });
    createSupabaseAdminClient.mockReturnValue(supabase);

    await dispatchMemoAssignmentImmediately(baseMemo);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/2/config',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('logs console.error and skips fetch when no webhook url found', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeSupabase({
      webhook_configs: { data: null, error: null },
      team_members: { data: null, error: null },
    });
    createSupabaseAdminClient.mockReturnValue(supabase);

    await dispatchMemoAssignmentImmediately(baseMemo);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[MemoDispatch]'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});
