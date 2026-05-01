import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const { createClient, findUserMapping, respond, syncSlackHitlRequestState } = vi.hoisted(() => ({
  createClient: vi.fn(),
  findUserMapping: vi.fn(),
  respond: vi.fn(),
  syncSlackHitlRequestState: vi.fn(),
}));

vi.mock('@/services/bridge-inbound', () => ({
  BridgeInboundService: class BridgeInboundService {
    findUserMapping = findUserMapping;
  },
}));
vi.mock('@/services/agent-hitl', async () => {
  class HitlConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'HitlConflictError';
    }
  }

  return {
    HitlConflictError,
    AgentHitlService: class AgentHitlService {
      respond = respond;
    },
  };
});
vi.mock('@/services/slack-hitl', () => ({
  syncSlackHitlRequestState,
}));

import { POST } from './route';

function makeSignature(secret: string, timestamp: string, body: string) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

function createSupabaseStub(requestRow: Record<string, unknown> | null) {
  return {
    from(table: string) {
      if (table === 'agent_hitl_requests') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: requestRow, error: null }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function makeRequest(payload: Record<string, unknown>, opts?: { signature?: string; timestamp?: string }) {
  const form = new URLSearchParams({ payload: JSON.stringify(payload) });
  const rawBody = form.toString();
  const timestamp = opts?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts?.signature ?? makeSignature(process.env.SLACK_SIGNING_SECRET!, timestamp, rawBody);

  return new Request('http://localhost/api/v1/bridge/slack/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body: rawBody,
  });
}

function createRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hitl-1',
    org_id: 'org-1',
    project_id: 'project-1',
    title: 'Need approval',
    prompt: 'Should I proceed?',
    requested_for: 'admin-1',
    status: 'pending',
    response_text: null,
    expires_at: null,
    metadata: {
      hitl_memo_id: 'memo-hitl-1',
      source_memo_id: 'memo-source-1',
      slack_team_id: 'T123',
      slack_channel_id: 'C123',
      slack_message_ts: '1710000001.000200',
    },
    ...overrides,
  };
}

function createApprovePayload(actionId = 'hitl_approve') {
  return {
    type: 'block_actions',
    team: { id: 'T123' },
    channel: { id: 'C123' },
    container: { channel_id: 'C123', message_ts: '1710000001.000200' },
    user: { id: 'U123', username: 'qasim' },
    actions: [{ action_id: actionId, value: JSON.stringify({ requestId: 'hitl-1' }) }],
  };
}

describe('POST /api/v1/bridge/slack/interactions', () => {
  beforeEach(() => {
    createClient.mockReset();
    findUserMapping.mockReset();
    respond.mockReset();
    syncSlackHitlRequestState.mockReset();
    process.env.SLACK_SIGNING_SECRET = 'route-signing-secret';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('returns 401 when the Slack signature is invalid', async () => {
    const response = await POST(makeRequest({ type: 'block_actions' }, { signature: 'v0=deadbeef' }));
    expect(response.status).toBe(401);
  });

  it('processes approve actions through AgentHitlService', async () => {
    createClient.mockReturnValue(createSupabaseStub(createRequestRow()));
    findUserMapping.mockResolvedValue({ team_member_id: 'admin-1', display_name: 'Qasim' });
    respond.mockResolvedValue({ id: 'hitl-1', status: 'approved' });

    const response = await POST(makeRequest(createApprovePayload()));

    expect(response.status).toBe(200);
    expect(respond).toHaveBeenCalledWith({
      requestId: 'hitl-1',
      actorId: 'admin-1',
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'approve',
      comment: 'Slack에서 승인한',
    });
    await expect(response.json()).resolves.toMatchObject({ text: 'HITL 승인 처리한.' });
  });

  it('rejects unknown action ids instead of default-approving them', async () => {
    createClient.mockReturnValue(createSupabaseStub(createRequestRow()));

    const response = await POST(makeRequest(createApprovePayload('totally_other_action')));

    expect(response.status).toBe(400);
    expect(respond).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ text: '지원하지 않는 HITL action인.' });
  });

  it('rejects interactions that do not originate from the stored Slack message', async () => {
    createClient.mockReturnValue(createSupabaseStub(createRequestRow()));

    const response = await POST(makeRequest({
      ...createApprovePayload(),
      channel: { id: 'C999' },
      container: { channel_id: 'C999', message_ts: '1710000001.000200' },
    }));

    expect(response.status).toBe(400);
    expect(respond).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ text: '원본 Slack HITL 메시지와 일치하지 않는 요청인.' });
  });

  it('syncs the Slack message on conflict and returns an ephemeral notice', async () => {
    createClient.mockReturnValue(createSupabaseStub(createRequestRow({
      status: 'approved',
      response_text: '승인',
    })));
    findUserMapping.mockResolvedValue({ team_member_id: 'admin-1', display_name: 'Qasim' });
    const { HitlConflictError } = await import('@/services/agent-hitl');
    respond.mockRejectedValue(new HitlConflictError('already processed'));

    const response = await POST(makeRequest(createApprovePayload()));

    expect(syncSlackHitlRequestState).toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: '이미 처리된 HITL 요청인.' });
  });
});
