import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSlackHitlBlocks,
  notifySlackHitlRequest,
  syncSlackHitlRequestState,
} from './slack-hitl';

function createDbStub(options?: {
  auth?: Record<string, unknown> | null;
  assignee?: Record<string, unknown> | null;
}) {
  const state = {
    requestUpdates: [] as Array<Record<string, unknown>>,
    memoReplies: [] as Array<Record<string, unknown>>,
  };

  const auth = options?.auth ?? { access_token_ref: 'env:SLACK_OAUTH_TOKEN_ORG_1', expires_at: null };
  const assignee = options?.assignee ?? { id: 'admin-1', name: 'Qasim' };

  const db = {
    from(table: string) {
      if (table === 'messaging_bridge_org_auths') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: auth, error: null }),
        };
      }

      if (table === 'team_members') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: assignee, error: null }),
        };
      }

      if (table === 'agent_hitl_requests') {
        return {
          update(payload: Record<string, unknown>) {
            state.requestUpdates.push(payload);
            return {
              eq() { return this; },
            };
          },
        };
      }

      if (table === 'memo_replies') {
        return {
          insert(payload: Record<string, unknown>) {
            state.memoReplies.push(payload);
            return Promise.resolve({ data: { id: `reply-${state.memoReplies.length}` }, error: null });
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return { db, state };
}

describe('slack hitl helpers', () => {
  beforeEach(() => {
    process.env.SLACK_OAUTH_TOKEN_ORG_1 = 'xoxb-hitl';
  });

  it('builds pending blocks with action buttons', () => {
    const blocks = buildSlackHitlBlocks({
      requestId: 'hitl-1',
      title: 'Need approval',
      prompt: 'Should I proceed?',
      assigneeName: 'Qasim',
      hitlMemoLink: 'https://app.example.com/memos?id=memo-hitl-1',
      sourceMemoLink: 'https://app.example.com/memos?id=memo-source-1',
      expiresAt: '2026-04-08T11:00:00.000Z',
      status: 'pending',
      responseText: null,
    });

    expect(blocks.some((block) => block.type === 'actions')).toBe(true);
  });

  it('builds resolved blocks without action buttons', () => {
    const blocks = buildSlackHitlBlocks({
      requestId: 'hitl-1',
      title: 'Need approval',
      prompt: 'Should I proceed?',
      assigneeName: 'Qasim',
      hitlMemoLink: 'https://app.example.com/memos?id=memo-hitl-1',
      sourceMemoLink: null,
      expiresAt: '2026-04-08T11:00:00.000Z',
      status: 'approved',
      responseText: '승인',
    });

    expect(blocks.some((block) => block.type === 'actions')).toBe(false);
  });
});

describe('notifySlackHitlRequest', () => {
  beforeEach(() => {
    process.env.SLACK_OAUTH_TOKEN_ORG_1 = 'xoxb-hitl';
  });

  it('posts a threaded Slack Block Kit HITL request and stores message metadata', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '1710000001.000200' }), { status: 200 }));
    const { db, state } = createDbStub();

    const result = await notifySlackHitlRequest(db as never, {
      request: {
        id: 'hitl-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Need approval',
        prompt: 'Should I proceed?',
        requested_for: 'admin-1',
        status: 'pending',
        response_text: null,
        expires_at: '2026-04-08T11:00:00.000Z',
        metadata: { hitl_memo_id: 'memo-hitl-1' },
      },
      sourceMemo: {
        id: 'memo-source-1',
        metadata: {
          source: 'slack',
          team_id: 'T123',
          channel_id: 'C123',
          thread_ts: '1710000000.000100',
        },
      },
      hitlMemoId: 'memo-hitl-1',
      createdBy: 'agent-1',
    }, {
      appUrl: 'https://app.example.com',
      fetchFn: fetchFn as typeof fetch,
      logger: console,
    });

    expect(result).toEqual({ status: 'sent', ts: '1710000001.000200' });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      channel: 'C123',
      thread_ts: '1710000000.000100',
      text: 'HITL 승인 요청 · Need approval',
    });
    expect(body.blocks.some((block: Record<string, unknown>) => block.type === 'actions')).toBe(true);
    expect(state.requestUpdates[0]).toMatchObject({
      metadata: expect.objectContaining({
        slack_team_id: 'T123',
        slack_channel_id: 'C123',
        slack_message_ts: '1710000001.000200',
      }),
    });
  });

  it('ignores Slack send failure and leaves a Sprintable memo comment', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 401 }));
    const { db, state } = createDbStub();

    const result = await notifySlackHitlRequest(db as never, {
      request: {
        id: 'hitl-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Need approval',
        prompt: 'Should I proceed?',
        requested_for: 'admin-1',
        status: 'pending',
        response_text: null,
        expires_at: '2026-04-08T11:00:00.000Z',
        metadata: { hitl_memo_id: 'memo-hitl-1' },
      },
      sourceMemo: {
        id: 'memo-source-1',
        metadata: {
          source: 'slack',
          team_id: 'T123',
          channel_id: 'C123',
          thread_ts: '1710000000.000100',
        },
      },
      hitlMemoId: 'memo-hitl-1',
      createdBy: 'agent-1',
    }, {
      appUrl: 'https://app.example.com',
      fetchFn: fetchFn as typeof fetch,
      logger: console,
    });

    expect(result).toEqual({ status: 'failed', reason: 'invalid_auth' });
    expect(state.memoReplies[0]).toMatchObject({
      memo_id: 'memo-hitl-1',
      created_by: 'agent-1',
    });
    expect(String(state.memoReplies[0]?.content)).toContain('Slack HITL 전송 실패');
  });
});

describe('syncSlackHitlRequestState', () => {
  beforeEach(() => {
    process.env.SLACK_OAUTH_TOKEN_ORG_1 = 'xoxb-hitl';
  });

  it('updates the Slack message to a non-interactive resolved state', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '1710000001.000200' }), { status: 200 }));
    const { db } = createDbStub();

    const result = await syncSlackHitlRequestState(db as never, {
      request: {
        id: 'hitl-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Need approval',
        prompt: 'Should I proceed?',
        requested_for: 'admin-1',
        status: 'approved',
        response_text: '승인',
        expires_at: '2026-04-08T11:00:00.000Z',
        metadata: {
          slack_channel_id: 'C123',
          slack_message_ts: '1710000001.000200',
        },
      },
      hitlMemoId: 'memo-hitl-1',
      sourceMemoId: 'memo-source-1',
      actorId: 'admin-1',
    }, {
      appUrl: 'https://app.example.com',
      fetchFn: fetchFn as typeof fetch,
      logger: console,
    });

    expect(result).toEqual({ status: 'updated' });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.ts).toBe('1710000001.000200');
    expect(body.blocks.some((block: Record<string, unknown>) => block.type === 'actions')).toBe(false);
  });
});
