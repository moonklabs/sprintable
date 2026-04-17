import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, checkProjectLimit } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  checkProjectLimit: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient,
}));

vi.mock('@/lib/check-feature', () => ({
  checkProjectLimit,
}));

import { GET, POST } from './route';

interface OrgMembershipRow {
  org_id: string;
  role: string;
}

interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  description?: string | null;
  created_at?: string;
}

function createSupabaseStub({
  user = { id: 'user-1', email: 'owner@sprintable.app', user_metadata: { name: 'Owner' } },
  orgMemberships = [{ org_id: 'org-1', role: 'admin' }],
  projects = [
    { id: 'project-1', org_id: 'org-1', name: 'Alpha', description: 'First project', created_at: '2026-04-13T00:00:00.000Z' },
  ],
  createdProject,
  createProjectError = null,
}: {
  user?: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null;
  orgMemberships?: OrgMembershipRow[];
  projects?: ProjectRow[];
  createdProject?: Partial<ProjectRow>;
  createProjectError?: { code?: string; message: string } | null;
} = {}) {
  let orgIdFilter: string | null = null;

  const orgMembersQuery = {
    select: vi.fn(() => orgMembersQuery),
    eq: vi.fn((column: string, value: string) => {
      if (column === 'user_id') return orgMembersQuery;
      if (column === 'org_id') {
        orgIdFilter = value;
        return Promise.resolve({
          data: orgMemberships.filter((membership) => membership.org_id === value),
          error: null,
        });
      }
      return orgMembersQuery;
    }),
    order: vi.fn(() => orgMembersQuery),
    limit: vi.fn(() => Promise.resolve({
      data: orgMemberships.slice(0, 2),
      error: null,
    })),
  };

  const projectsListQuery = {
    eq: vi.fn((column: string, value: string) => {
      if (column === 'org_id') orgIdFilter = value;
      return projectsListQuery;
    }),
    order: vi.fn(() => Promise.resolve({
      data: projects.filter((project) => (orgIdFilter ? project.org_id === orgIdFilter : true)),
      error: null,
    })),
  };

  const projectsTable = {
    select: vi.fn(() => projectsListQuery),
  };

  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'create_project_with_creator_membership') {
      return {
        data: createProjectError ? null : {
          id: createdProject?.id ?? 'project-new',
          org_id: args._org_id as string,
          name: (createdProject?.name ?? args._name ?? 'New Project') as string,
          description: (createdProject?.description ?? args._description ?? null) as string | null,
          created_at: createdProject?.created_at ?? '2026-04-13T00:00:00.000Z',
        },
        error: createProjectError,
      };
    }

    throw new Error(`Unexpected rpc: ${fn}`);
  });

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn((table: string) => {
      if (table === 'org_members') return orgMembersQuery;
      if (table === 'projects') return projectsTable;
      throw new Error(`Unexpected table: ${table}`);
    }),
    rpc,
    __mocks: {
      projectsTable,
      orgMembersQuery,
      rpc,
    },
  };
}

describe('GET /api/projects', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    checkProjectLimit.mockReset();
  });

  it('returns only projects from the requested organization when the user belongs to it', async () => {
    const supabase = createSupabaseStub({
      orgMemberships: [{ org_id: 'org-1', role: 'member' }],
      projects: [
        { id: 'project-1', org_id: 'org-1', name: 'Alpha' },
        { id: 'project-2', org_id: 'org-2', name: 'Other org' },
      ],
    });
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/projects?org_id=org-1'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([
      expect.objectContaining({ id: 'project-1', name: 'Alpha' }),
    ]);
    expect(body.data).toHaveLength(1);
  });

  it('requires org_id when the user belongs to multiple organizations', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub({
      orgMemberships: [
        { org_id: 'org-1', role: 'admin' },
        { org_id: 'org-2', role: 'member' },
      ],
    }));

    const response = await GET(new Request('http://localhost/api/projects'));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('org_id required');
  });
});

describe('POST /api/projects', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    checkProjectLimit.mockReset();
    checkProjectLimit.mockResolvedValue({ allowed: true });
  });

  it('returns validation errors for malformed payloads', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub());

    const response = await POST(new Request('http://localhost/api/projects', {
      method: 'POST',
      body: JSON.stringify({ org_id: 'org-1', name: '' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects project creation for non-admin members', async () => {
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub({
      orgMemberships: [{ org_id: 'org-1', role: 'member' }],
    }));

    const response = await POST(new Request('http://localhost/api/projects', {
      method: 'POST',
      body: JSON.stringify({ org_id: 'org-1', name: 'New Project' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('Admin access required');
    expect(checkProjectLimit).not.toHaveBeenCalled();
  });

  it('surfaces project limit errors from feature gating', async () => {
    checkProjectLimit.mockResolvedValue({
      allowed: false,
      reason: 'Project limit reached (3). Upgrade to Team.',
    });
    createSupabaseServerClient.mockResolvedValue(createSupabaseStub());

    const response = await POST(new Request('http://localhost/api/projects', {
      method: 'POST',
      body: JSON.stringify({ org_id: 'org-1', name: 'New Project' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('UPGRADE_REQUIRED');
    expect(body.error.message).toBe('Project limit reached (3). Upgrade to Team.');
  });

  it('creates the project and provisions the creator membership atomically through a single RPC', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await POST(new Request('http://localhost/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        org_id: 'org-1',
        name: 'Operator Console',
        description: 'Settings-surface project creation',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toEqual(expect.objectContaining({ name: 'Operator Console' }));
    expect(checkProjectLimit).toHaveBeenCalledWith(supabase, 'org-1');
    expect(supabase.__mocks.rpc).toHaveBeenCalledWith('create_project_with_creator_membership', {
      _org_id: 'org-1',
      _name: 'Operator Console',
      _description: 'Settings-surface project creation',
      _creator_name: 'Owner',
    });
  });

  it('surfaces atomic create RPC failures without falling back to direct project inserts', async () => {
    const supabase = createSupabaseStub({
      createProjectError: { message: 'creator_membership_provision_failed' },
    });
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await POST(new Request('http://localhost/api/projects', {
      method: 'POST',
      body: JSON.stringify({ org_id: 'org-1', name: 'Operator Console' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(supabase.__mocks.projectsTable.select).not.toHaveBeenCalled();
    expect(supabase.__mocks.rpc).toHaveBeenCalledWith('create_project_with_creator_membership', {
      _org_id: 'org-1',
      _name: 'Operator Console',
      _description: null,
      _creator_name: 'Owner',
    });
  });
});
