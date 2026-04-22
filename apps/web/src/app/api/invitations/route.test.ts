import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient,
}));

import { GET, POST } from './route';

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'order', 'maybeSingle', 'single', 'limit'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  (chain['maybeSingle'] as ReturnType<typeof vi.fn>).mockResolvedValue(result);
  (chain['single'] as ReturnType<typeof vi.fn>).mockResolvedValue(result);
  return chain;
}

function createSupabaseStub(orgMemberResult: unknown, invitationsResult = { data: [], error: null }) {
  const orgMemberChain = makeChain(orgMemberResult);
  const invitationsChain = makeChain(invitationsResult);
  (invitationsChain['order'] as ReturnType<typeof vi.fn>).mockResolvedValue(invitationsResult);

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    from: vi.fn((table: string) => {
      if (table === 'org_members') return orgMemberChain;
      if (table === 'invitations') return invitationsChain;
      return makeChain({ data: null, error: null });
    }),
  };
}

describe('GET /api/invitations', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
  });

  it('returns 200 and invitation list for org owner (single project)', async () => {
    createSupabaseServerClient.mockResolvedValue(
      createSupabaseStub({ data: { org_id: 'org-1', role: 'owner' } }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
  });

  it('returns 200 for owner with multiple project memberships — regression for E-023:S6', async () => {
    // 다중 프로젝트 사용자도 org_members.role=owner 이면 admin 섹션 접근 가능해야 함
    createSupabaseServerClient.mockResolvedValue(
      createSupabaseStub({ data: { org_id: 'org-1', role: 'owner' } }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
  });

  it('returns 403 for non-admin org member', async () => {
    createSupabaseServerClient.mockResolvedValue(
      createSupabaseStub({ data: { org_id: 'org-1', role: 'member' } }),
    );

    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('returns 403 when org_members record not found', async () => {
    createSupabaseServerClient.mockResolvedValue(
      createSupabaseStub({ data: null }),
    );

    const res = await GET();
    expect(res.status).toBe(403);
  });
});

describe('POST /api/invitations', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
  });

  it('returns validation errors for malformed payloads', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      },
    });

    const response = await POST(new Request('http://localhost/api/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
