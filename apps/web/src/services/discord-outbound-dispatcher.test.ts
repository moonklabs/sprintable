
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiscordMemoLink,
  buildDiscordOutboundChunks,
  DiscordOutboundDispatcher,
  isDiscordSourceMemo,
} from './discord-outbound-dispatcher';

function createDbStub(options?: {
  memo?: Record<string, unknown> | null;
  channelMapping?: Record<string, unknown> | null;
  activeAgent?: Record<string, unknown> | null;
  auth?: Record<string, unknown> | null;
  existingDispatches?: Array<Record<string, unknown>>;
}) {
  const state = {
    insertedReplies: [] as Array<Record<string, unknown>>,
    insertedNotifications: [] as Array<Record<string, unknown>>,
    dispatches: [...(options?.existingDispatches ?? [])] as Array<Record<string, unknown>>,
    removedChannels: 0,
  };

  const channel = {
    on: vi.fn(() => channel),
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
      source: 'discord',
      channel_id: 'channel-parent-1',
      thread_id: 'thread-1',
      discord_message_id: 'message-1',
    },
  };

  const channelMapping = options?.channelMapping ?? { channel_id: 'channel-parent-1' };
  const activeAgent = options?.activeAgent ?? { id: 'agent-1' };
  const authRow = options?.auth ?? {
    org_id: 'org-1',
    access_token_ref: 'env:DISCORD_BOT_TOKEN',
    expires_at: null,
  };

  const db = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => {
      state.removedChannels += 1;
    }),
    from(table: string) {
      if (table === 'memos') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
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
        let orgFilter: string | null = null;
        let typeFilter: string | null = null;
        let userIdsFilter: string[] | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'id') idFilter = String(value);
            if (column === 'org_id') orgFilter = String(value);
            if (column === 'type') typeFilter = String(value);
            return this;
          },
          in(_column: string, values: string[]) { userIdsFilter = values; return this; },
          maybeSingle: async () => ({
            data: activeAgent && idFilter === activeAgent.id && orgFilter === 'org-1' && typeFilter === 'agent' ? activeAgent : null,
            error: null,
          }),
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            const data = typeFilter === 'human' && userIdsFilter?.includes('user-1')
              ? [{ id: 'admin-1', user_id: 'user-1' }]
              : [];
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
      }

      if (table === 'messaging_bridge_org_auths') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: authRow, error: null }),
        };
      }

      if (table === 'org_members') {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: [{ user_id: 'user-1' }], error: null }).then(resolve);
          },
        };
      }

      if (table === 'notifications') {
        return {
          insert: async (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
            state.insertedNotifications.push(...(Array.isArray(payload) ? payload : [payload]));
            return { error: null };
          },
        };
      }

      if (table === 'memo_replies') {
        return {
          insert(payload: Record<string, unknown>) {
            state.insertedReplies.push(payload);
            return {
              select() { return this; },
              single: async () => ({ data: { id: `reply-${state.insertedReplies.length}`, ...payload }, error: null }),
            };
          },
        };
      }

      if (table === 'messaging_bridge_reply_dispatches') {
        const filters: Array<{ column: string; value: unknown }> = [];
        let payload: Record<string, unknown> | null = null;
        let mode: 'insert' | 'update' | 'select' = 'select';
        const execute = async () => {
          if (mode === 'insert') {
            const duplicate = state.dispatches.find((row) => row.platform === payload?.platform && row.reply_id === payload?.reply_id);
            if (duplicate) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
            const row = {
              id: `dispatch-${state.dispatches.length + 1}`,
              updated_at: '2026-04-08T12:00:00.000Z',
              sent_at: null,
              error_message: null,
              ...payload,
            };
            state.dispatches.push(row);
            return { data: row, error: null };
          }

          if (mode === 'update') {
            const row = state.dispatches.find((candidate) => filters.every((filter) => candidate[filter.column] === filter.value)) ?? null;
            if (!row) return { data: null, error: null };
            Object.assign(row, payload ?? {}, { updated_at: '2026-04-08T12:01:00.000Z' });
            return { data: row, error: null };
          }

          const row = state.dispatches.find((candidate) => filters.every((filter) => candidate[filter.column] === filter.value)) ?? null;
          return { data: row, error: null };
        };

        return {
          select() { return this; },
          insert(next: Record<string, unknown>) { mode = 'insert'; payload = next; return this; },
          update(next: Record<string, unknown>) { mode = 'update'; payload = next; return this; },
          eq(column: string, value: unknown) { filters.push({ column, value }); return this; },
          maybeSingle: execute,
          then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
            return Promise.resolve(execute()).then(resolve);
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as any;

  return { db, state };
}

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.APP_BASE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  vi.restoreAllMocks();
});

describe('discord outbound helpers', () => {
  it('identifies Discord source memos', () => {
    expect(isDiscordSourceMemo({ source: 'discord', channel_id: 'channel-1' })).toBe(true);
    expect(isDiscordSourceMemo({ source: 'slack', channel_id: 'channel-1' })).toBe(false);
  });

  it('builds memo deep-links and splits long Discord messages into <=2000-char chunks', () => {
    const link = buildDiscordMemoLink('https://app.example.com/', 'memo-1');
    const chunks = buildDiscordOutboundChunks('a'.repeat(5000), link);

    expect(link).toBe('https://app.example.com/memos?id=memo-1');
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
  });

  it('falls back to APP_BASE_URL when explicit appUrl is missing', () => {
    process.env.APP_BASE_URL = 'https://myapp.example.com';

    expect(buildDiscordMemoLink(undefined, 'memo-1')).toBe('https://myapp.example.com/memos?id=memo-1');
  });
});

describe('DiscordOutboundDispatcher', () => {
  it('splits oversized replies into multiple Discord REST messages and records a durable sent marker', async () => {
    process.env.DISCORD_BOT_TOKEN = 'discord-bot-token';
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'message-1' }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ id: 'message-2' }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ id: 'message-3' }), { status: 200 }));
    const { db, state } = createDbStub();
    const dispatcher = new DiscordOutboundDispatcher({
      db,
      fetchFn: fetchFn as typeof fetch,
      appUrl: 'https://app.example.com',
      retryDelayMs: 0,
    });

    const reply = {
      id: 'reply-1',
      memo_id: 'memo-1',
      content: 'a'.repeat(5000),
      created_by: 'agent-1',
      created_at: '2026-04-08T00:00:00.000Z',
    };

    const first = await dispatcher.dispatchReplyIfNeeded(reply);
    const second = await dispatcher.dispatchReplyIfNeeded(reply);

    expect(first).toMatchObject({ status: 'sent', attempts: 1, chunkCount: 3 });
    expect(second).toEqual({ status: 'skipped', reason: 'reply_already_dispatched' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(state.dispatches[0]).toMatchObject({
      platform: 'discord',
      reply_id: 'reply-1',
      status: 'sent',
    });
  });

  it('records auth_failed and notifies admins when the Discord token is expired', async () => {
    const { db, state } = createDbStub({
      auth: {
        org_id: 'org-1',
        access_token_ref: 'env:DISCORD_BOT_TOKEN',
        expires_at: '2026-04-07T00:00:00.000Z',
      },
    });
    const dispatcher = new DiscordOutboundDispatcher({ db, retryDelayMs: 0 });

    const result = await dispatcher.dispatchReplyIfNeeded({
      id: 'reply-2',
      memo_id: 'memo-1',
      content: 'auth failure please',
      created_by: 'agent-1',
      created_at: '2026-04-08T00:00:00.000Z',
    });

    expect(result).toEqual({ status: 'failed', reason: 'auth_failed', attempts: 1 });
    expect(state.insertedReplies[0]).toMatchObject({ memo_id: 'memo-1', created_by: 'agent-1' });
    expect(String(state.insertedReplies[0]?.content)).toContain('Discord 전송 실패');
    expect(state.insertedNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ org_id: 'org-1', title: 'Discord bridge auth_failed' }),
    ]));
    expect(state.dispatches[0]).toMatchObject({ status: 'failed', error_message: 'auth_failed' });
  });
});
