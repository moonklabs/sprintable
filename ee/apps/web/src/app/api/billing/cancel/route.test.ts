import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getMyTeamMember, requireOrgAdmin } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));

import { POST } from './route';

function createSupabaseStub() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  };
}

describe('POST /api/billing/cancel', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
  });

  it('returns validation errors for malformed payloads', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub());
    getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1' });
    requireOrgAdmin.mockResolvedValue(undefined);

    const response = await POST(new Request('http://localhost/api/billing/cancel', {
      method: 'POST',
      body: JSON.stringify({ immediately: 'yes' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
