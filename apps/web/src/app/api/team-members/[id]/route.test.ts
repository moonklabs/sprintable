import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, createSupabaseAdminClient, getMyTeamMember, getAuthContext } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  getAuthContext: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient,
}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));

vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return {
    ...actual,
    getMyTeamMember,
    getAuthContext,
  };
});

import { DELETE } from './route';

function createDeleteSupabaseStub(activeMembershipCount: number) {
  let teamMembersCall = 0;

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'admin-user' } } }),
    },
    from: vi.fn((table: string) => {
      if (table !== 'team_members') throw new Error(`Unexpected table: ${table}`);
      teamMembersCall += 1;

      if (teamMembersCall === 1) {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 'member-1', org_id: 'org-1', user_id: 'user-2', type: 'human', is_active: true },
            error: null,
          }),
        };
        return query;
      }

      if (teamMembersCall === 2) {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          then: (resolve: (value: { count: number; error: null }) => void) => Promise.resolve({ count: activeMembershipCount, error: null }).then(resolve),
        };
        return query;
      }

      const query = {
        update: vi.fn(() => query),
        eq: vi.fn(() => query),
        then: (resolve: (value: { error: null }) => void) => Promise.resolve({ error: null }).then(resolve),
      };
      return query;
    }),
  };
}

describe('DELETE /api/team-members/[id]', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    createSupabaseAdminClient.mockReset();
    getMyTeamMember.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReturnValue({ from: () => ({ insert: () => ({ then: (r: (v: unknown) => void) => Promise.resolve({ error: null }).then(r) }) }) });
    getMyTeamMember.mockResolvedValue({ id: 'admin-team-member', org_id: 'org-1', project_id: 'project-1' });
    getAuthContext.mockResolvedValue({ id: 'admin-team-member', org_id: 'org-1', project_id: 'project-1', type: 'human' as const });
  });

  it('blocks removing the last active project membership for a human member', async () => {
    createSupabaseServerClient.mockResolvedValue(createDeleteSupabaseStub(1));

    const response = await DELETE(new Request('http://localhost/api/team-members/member-1', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'member-1' }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('LAST_PROJECT_MEMBERSHIP');
  });

  it('allows deactivation when another active project membership exists', async () => {
    createSupabaseServerClient.mockResolvedValue(createDeleteSupabaseStub(2));

    const response = await DELETE(new Request('http://localhost/api/team-members/member-1', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'member-1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.ok).toBe(true);
    expect(body.data.id).toBe('member-1');
  });
});
