import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildSlackMemoLink,
  buildSlackOutboundText,
  isFailureComment,
  isSlackSourceMemo,
  SlackOutboundDispatcher,
} from './slack-outbound-dispatcher';

function createSupabaseStub(options?: {
  memo?: Record<string, unknown> | null;
  channelMapping?: Record<string, unknown> | null;
  activeAgent?: Record<string, unknown> | null;
}) {
  const state = {
    insertedReplies: [] as Array<Record<string, unknown>>,
    replyInsertCount: 0,
    replyInsertHandler: null as ((payload: { new: Record<string, unknown> }) => void) | null,
    removedChannels: 0,
  };

  const channel = {
    on: vi.fn((event: string, filter: Record<string, unknown>, handler: (payload: { new: Record<string, unknown> }) => void) => {
      if (event === 'postgres_changes' && filter.table === 'memo_replies') {
        state.replyInsertHandler = handler;
      }
      return channel;
    }),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      callback?.('SUBSCRIBED');
      return channel;
    }),
  };

  const memoRow = options?.memo ?? {
    id: 'memo-1',
    org_id: 'org-1',
    project_id: 'project-1',
    metadata: {
      source: 'slack',
      channel_id: 'C123',
      thread_ts: '1710000000.000001',
    },
  };

  const channelMapping = options?.channelMapping ?? {
    channel_id: 'C123',
    config: {
      bot_token: 'env:SLACK_BOT_TOKEN',
    },
  };

  const activeAgent = options?.activeAgent ?? { id: 'agent-1' };

  const supabase = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => {
      state.removedChannels += 1;
    }),
    from(table: string) {
      if (table === 'memos') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: memoRow, error: null }),
          single: async () => ({ data: memoRow, error: null }),
        };
      }

      if (table === 'messaging_bridge_channels') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: channelMapping, error: null }),
        };
      }

      if (table === 'team_members') {
        let idFilter: string | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'id' && typeof value === 'string') {
              idFilter = value;
            }
            return this;
          },
          maybeSingle: async () => ({
            data: activeAgent && idFilter === activeAgent.id ? activeAgent : null,
            error: null,
          }),
        };
      }

      if (table === 'memo_replies') {
        return {
          insert(payload: Record<string, unknown>) {
            state.insertedReplies.push(payload);
            state.replyInsertCount += 1;
            return {
              select() { return this; },
              single: async () => ({ data: { id: `reply-${state.replyInsertCount}`, ...payload }, error: null }),
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { supabase, state };
}

afterEach(() => {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  vi.restoreAllMocks();
});

describe('slack outbound helpers', () => {
  it('identifies Slack source memos', () => {
    expect(isSlackSourceMemo({ source: 'slack', channel_id: 'C1' })).toBe(true);
    expect(isSlackSourceMemo({ source: 'discord', channel_id: 'C1' })).toBe(false);
  });

  it('detects failure comments', () => {
    expect(isFailureComment('Slack 전송 실패\n- reason: invalid_auth')).toBe(true);
    expect(isFailureComment('normal reply')).toBe(false);
  });

  it('builds live memo deep-links and truncates long messages to 3000 chars with a Sprintable link', () => {
    const link = buildSlackMemoLink('https://app.example.com/', 'memo-1');
    const text = buildSlackOutboundText('a'.repeat(3200), link);

    expect(link).toBe('https://app.example.com/memos?id=memo-1');
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain('전체 내용은 Sprintable에서 확인하세요 https://app.example.com/memos?id=memo-1');
  });

  it('falls back to the production app URL when explicit appUrl is missing', () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'sprintable.vercel.app';

    expect(buildSlackMemoLink(undefined, 'memo-1')).toBe('https://sprintable.vercel.app/memos?id=memo-1');
  });
});

describe('SlackOutboundDispatcher', () => {
  it('sends threaded Slack replies when thread_ts exists', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-thread';
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { supabase } = createSupabaseStub();
    const dispatcher = new SlackOutboundDispatcher({
      supabase,
      fetchFn: fetchFn as typeof fetch,
      appUrl: 'https://app.example.com',
      retryDelayMs: 0,
    });

    const result = await dispatcher.dispatchReplyIfNeeded({
      id: 'reply-1',
      memo_id: 'memo-1',
      content: 'reply content',
      created_by: 'agent-1',
      created_at: '2026-04-07T00:00:00.000Z',
    });

    expect(result).toEqual({ status: 'sent', attempts: 1 });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      channel: 'C123',
      text: 'reply content',
      thread_ts: '1710000000.000001',
    });
  });

  it('sends new Slack messages when thread_ts is absent', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-root';
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { supabase } = createSupabaseStub({
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        metadata: {
          source: 'slack',
          channel_id: 'C123',
          thread_ts: null,
        },
      },
    });
    const dispatcher = new SlackOutboundDispatcher({
      supabase,
      fetchFn: fetchFn as typeof fetch,
      appUrl: 'https://app.example.com',
      retryDelayMs: 0,
    });

    await dispatcher.dispatchReplyIfNeeded({
      id: 'reply-2',
      memo_id: 'memo-1',
      content: 'root reply',
      created_by: 'agent-1',
      created_at: '2026-04-07T00:00:00.000Z',
    });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.channel).toBe('C123');
    expect(body.text).toBe('root reply');
    expect(body).not.toHaveProperty('thread_ts');
  });

  it('retries Slack API failures up to 3 times and writes a Sprintable failure comment', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-fail';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 401 }));
    const { supabase, state } = createSupabaseStub();
    const dispatcher = new SlackOutboundDispatcher({
      supabase,
      fetchFn: fetchFn as typeof fetch,
      retryDelayMs: 0,
      maxRetries: 3,
    });

    const result = await dispatcher.dispatchReplyIfNeeded({
      id: 'reply-3',
      memo_id: 'memo-1',
      content: 'send failure please',
      created_by: 'agent-1',
      created_at: '2026-04-07T00:00:00.000Z',
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ status: 'failed', reason: 'http_401', attempts: 3 });
    expect(state.insertedReplies[0]).toMatchObject({
      memo_id: 'memo-1',
      created_by: 'agent-1',
    });
    expect(String(state.insertedReplies[0]?.content)).toContain('Slack 전송 실패');
    expect(String(state.insertedReplies[0]?.content)).toContain('http_401');
  });

  it('skips replies that are not authored by an active agent in the same project', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-human-skip';
    const fetchFn = vi.fn();
    const { supabase } = createSupabaseStub();
    const dispatcher = new SlackOutboundDispatcher({ supabase, fetchFn: fetchFn as typeof fetch, retryDelayMs: 0 });

    const result = await dispatcher.dispatchReplyIfNeeded({
      id: 'reply-human',
      memo_id: 'memo-1',
      content: 'human internal note',
      created_by: 'human-1',
      created_at: '2026-04-07T00:00:00.000Z',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'reply_not_from_active_agent' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips non-slack source memos', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-skip';
    const fetchFn = vi.fn();
    const { supabase } = createSupabaseStub({
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        metadata: { source: 'email', channel_id: 'mail-1' },
      },
    });
    const dispatcher = new SlackOutboundDispatcher({ supabase, fetchFn: fetchFn as typeof fetch, retryDelayMs: 0 });

    const result = await dispatcher.dispatchReplyIfNeeded({
      id: 'reply-4',
      memo_id: 'memo-1',
      content: 'ignore me',
      created_by: 'agent-1',
      created_at: '2026-04-07T00:00:00.000Z',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'memo_not_slack_source' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('subscribes to memo reply realtime events and dispatches them', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-realtime';
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { supabase, state } = createSupabaseStub();
    const dispatcher = new SlackOutboundDispatcher({
      supabase,
      fetchFn: fetchFn as typeof fetch,
      retryDelayMs: 0,
    });

    dispatcher.start();
    state.replyInsertHandler?.({
      new: {
        id: 'reply-5',
        memo_id: 'memo-1',
        content: 'realtime reply',
        created_by: 'agent-1',
        created_at: '2026-04-07T00:00:00.000Z',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await dispatcher.stop();
    expect(state.removedChannels).toBe(1);
  });
});
