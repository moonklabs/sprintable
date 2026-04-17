import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  requireAgentOrchestration,
  getProjectPolicy,
  saveProjectPolicy,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  requireAgentOrchestration: vi.fn(),
  getProjectPolicy: vi.fn(),
  saveProjectPolicy: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', () => ({ getMyTeamMember }));
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
vi.mock('@/lib/require-agent-orchestration', () => ({ requireAgentOrchestration }));
vi.mock('@/services/agent-hitl-policy', () => ({
  HITL_APPROVAL_RULE_KEYS: ['manual_hitl_request', 'billing_cap_exceeded'],
  HITL_REQUEST_TYPES: ['approval'],
  HITL_TIMEOUT_CLASS_KEYS: ['fast', 'standard', 'extended'],
  HITL_ESCALATION_MODES: ['timeout_memo', 'timeout_memo_and_escalate'],
  AgentHitlPolicyService: class AgentHitlPolicyService {
    getProjectPolicy = getProjectPolicy;
    saveProjectPolicy = saveProjectPolicy;
  },
}));

import { GET, PATCH } from './route';

function createSupabaseStub(userId: string | null = 'user-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: userId ? { id: userId } : null } })),
    },
  };
}

describe('GET/PATCH /api/v1/hitl-policy', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    requireAgentOrchestration.mockReset();
    getProjectPolicy.mockReset();
    saveProjectPolicy.mockReset();

    createSupabaseServerClient.mockResolvedValue(createSupabaseStub());
    getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('returns the current project HITL policy for admins', async () => {
    getProjectPolicy.mockResolvedValue({ schema_version: 1, approval_rules: [], timeout_classes: [], high_risk_actions: [], prompt_summary: 'summary' });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: expect.objectContaining({ prompt_summary: 'summary' }),
    });
    expect(getProjectPolicy).toHaveBeenCalledWith({ orgId: 'org-1', projectId: 'project-1' });
  });

  it('rejects invalid timeout policies before saving', async () => {
    const response = await PATCH(new Request('http://localhost/api/v1/hitl-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approval_rules: [
          {
            key: 'manual_hitl_request',
            request_type: 'approval',
            timeout_class: 'standard',
            approval_required: true,
          },
        ],
        timeout_classes: [
          {
            key: 'standard',
            duration_minutes: 60,
            reminder_minutes_before: 60,
            escalation_mode: 'timeout_memo',
          },
        ],
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.objectContaining({ code: 'BAD_REQUEST' }),
    });
    expect(saveProjectPolicy).not.toHaveBeenCalled();
  });

  it('rejects unsupported non-approval request types', async () => {
    const response = await PATCH(new Request('http://localhost/api/v1/hitl-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approval_rules: [
          {
            key: 'manual_hitl_request',
            request_type: 'confirmation',
            timeout_class: 'extended',
            approval_required: true,
          },
        ],
        timeout_classes: [
          {
            key: 'extended',
            duration_minutes: 2880,
            reminder_minutes_before: 240,
            escalation_mode: 'timeout_memo_and_escalate',
          },
        ],
      }),
    }));

    expect(response.status).toBe(400);
    expect(saveProjectPolicy).not.toHaveBeenCalled();
  });

  it('persists a valid policy update', async () => {
    saveProjectPolicy.mockResolvedValue({ schema_version: 1, approval_rules: [], timeout_classes: [], high_risk_actions: [], prompt_summary: 'saved-summary' });

    const response = await PATCH(new Request('http://localhost/api/v1/hitl-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approval_rules: [
          {
            key: 'manual_hitl_request',
            request_type: 'approval',
            timeout_class: 'extended',
            approval_required: true,
          },
          {
            key: 'billing_cap_exceeded',
            request_type: 'approval',
            timeout_class: 'fast',
            approval_required: true,
          },
        ],
        timeout_classes: [
          {
            key: 'fast',
            duration_minutes: 120,
            reminder_minutes_before: 30,
            escalation_mode: 'timeout_memo_and_escalate',
          },
          {
            key: 'standard',
            duration_minutes: 1440,
            reminder_minutes_before: 60,
            escalation_mode: 'timeout_memo',
          },
          {
            key: 'extended',
            duration_minutes: 2880,
            reminder_minutes_before: 240,
            escalation_mode: 'timeout_memo_and_escalate',
          },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    expect(saveProjectPolicy).toHaveBeenCalledWith({ orgId: 'org-1', projectId: 'project-1', actorId: 'tm-1' }, expect.objectContaining({
      approval_rules: expect.any(Array),
      timeout_classes: expect.any(Array),
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: expect.objectContaining({ prompt_summary: 'saved-summary' }),
    });
  });
});
