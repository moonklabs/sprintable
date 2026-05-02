
import type { SupabaseClient } from '@/types/supabase';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  BridgeInboundService,
  checkChannelRateLimit,
  normalizeBridgeMetadata,
  resetBridgeRateLimiter,
  type BridgeChannelMapping,
  type BridgeInboundEvent,
} from '../bridge-inbound';
import {
  normalizeSlackEvent,
  postSlackRateLimitNotice,
  resolveSecret,
  resolveSlackBridgeConfig,
  shouldIgnoreSlackMessage,
  verifySlackSignature,
  type SlackBridgeConfig,
  type SlackMessageEvent,
} from '../slack-inbound';

const SIGNING_SECRET = 'test-signing-secret';

const CHANNEL_MAPPING: BridgeChannelMapping = {
  id: 'bridge-channel-1',
  org_id: 'org-1',
  project_id: 'project-1',
  platform: 'slack',
  channel_id: 'C1234',
  config: null,
  is_active: true,
};

function makeSignature(secret: string, timestamp: string, body: string) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

function nowTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

function createDbStub(overrides: {
  channelData?: unknown;
  userData?: unknown;
  existingMemoData?: unknown;
  memoInsertError?: { code?: string; message?: string } | null;
  agentFallbackData?: unknown;
  humanFallbackData?: unknown;
  projectScopedMemberData?: unknown;
  projectData?: unknown;
} = {}) {
  const state = {
    insertedMemos: [] as Array<Record<string, unknown>>,
  };

  const makeQuery = (table: string) => {
    let typeFilter: string | null = null;
    let idFilter: string | null = null;
    let containsMetadata = false;

    const resolveScopedMember = () => {
      const scopedMember = Object.prototype.hasOwnProperty.call(overrides, 'projectScopedMemberData')
        ? overrides.projectScopedMemberData
        : { id: 'tm-1' };

      if (!scopedMember) return null;
      if (
        typeof scopedMember === 'object'
        && scopedMember !== null
        && 'id' in scopedMember
        && idFilter
        && (scopedMember as { id: string }).id !== idFilter
      ) {
        return null;
      }

      return scopedMember;
    };

    const query = {
      select: vi.fn(() => query),
      insert: vi.fn((payload: Record<string, unknown>) => {
        if (table === 'memos' && !overrides.memoInsertError) state.insertedMemos.push(payload);
        return query;
      }),
      eq: vi.fn((column: string, value: string | boolean) => {
        if (table === 'team_members' && column === 'type' && typeof value === 'string') {
          typeFilter = value;
        }
        if (table === 'team_members' && column === 'id' && typeof value === 'string') {
          idFilter = value;
        }
        return query;
      }),
      contains: vi.fn(() => {
        containsMetadata = true;
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        if (table === 'messaging_bridge_channels') {
          return { data: Object.prototype.hasOwnProperty.call(overrides, 'channelData') ? overrides.channelData : CHANNEL_MAPPING, error: null };
        }
        if (table === 'messaging_bridge_users') {
          return { data: Object.prototype.hasOwnProperty.call(overrides, 'userData') ? overrides.userData : { team_member_id: 'tm-1', display_name: 'Alice' }, error: null };
        }
        if (table === 'team_members') {
          if (typeFilter === 'agent') {
            return { data: Object.prototype.hasOwnProperty.call(overrides, 'agentFallbackData') ? overrides.agentFallbackData : { id: 'agent-1' }, error: null };
          }
          if (typeFilter === 'human') {
            return { data: Object.prototype.hasOwnProperty.call(overrides, 'humanFallbackData') ? overrides.humanFallbackData : { id: 'human-1' }, error: null };
          }
          return { data: resolveScopedMember(), error: null };
        }
        if (table === 'projects') {
          return { data: Object.prototype.hasOwnProperty.call(overrides, 'projectData') ? overrides.projectData : { id: 'project-1', org_id: 'org-1' }, error: null };
        }
        if (table === 'memos' && containsMetadata) {
          return { data: Object.prototype.hasOwnProperty.call(overrides, 'existingMemoData') ? overrides.existingMemoData : null, error: null };
        }
        return { data: null, error: null };
      }),
      single: vi.fn(async () => {
        if (table === 'projects') {
          return { data: Object.prototype.hasOwnProperty.call(overrides, 'projectData') ? overrides.projectData : { id: 'project-1', org_id: 'org-1' }, error: null };
        }
        if (table === 'memos') {
          if (overrides.memoInsertError) {
            return { data: null, error: overrides.memoInsertError };
          }
          const payload = state.insertedMemos.at(-1) ?? {};
          return { data: { id: `memo-${state.insertedMemos.length}`, ...payload }, error: null };
        }
        if (table === 'team_members') {
          return { data: resolveScopedMember(), error: null };
        }
        return { data: null, error: null };
      }),
    };

    return query;
  };

  const db = {
    from(table: string) {
      return makeQuery(table);
    },
  } as unknown as SupabaseClient;

  return { db, state };
}

describe('verifySlackSignature', () => {
  it('accepts a valid signature', () => {
    const timestamp = nowTimestamp();
    const body = JSON.stringify({ type: 'event_callback' });
    const signature = makeSignature(SIGNING_SECRET, timestamp, body);

    expect(verifySlackSignature(SIGNING_SECRET, signature, timestamp, body)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifySlackSignature(SIGNING_SECRET, 'v0=deadbeef', nowTimestamp(), '{}')).toBe(false);
  });

  it('rejects stale timestamps', () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 301);
    const body = '{}';
    const signature = makeSignature(SIGNING_SECRET, timestamp, body);

    expect(verifySlackSignature(SIGNING_SECRET, signature, timestamp, body)).toBe(false);
  });
});

describe('Slack adapter helpers', () => {
  afterEach(() => {
    delete process.env.TEST_SECRET;
    delete process.env.SLACK_REQUIRE_MENTION;
    delete process.env.SLACK_BOT_USER_ID;
    delete process.env.SLACK_BOT_TOKEN;
  });

  it('resolves env refs and fails safely for vault refs', () => {
    process.env.TEST_SECRET = 'hello';
    expect(resolveSecret('env:TEST_SECRET')).toBe('hello');
    expect(resolveSecret('vault:kv/slack/signing')).toBeNull();
  });

  it('normalizes Slack config from secret refs', () => {
    process.env.SLACK_REQUIRE_MENTION = 'true';
    process.env.SLACK_BOT_USER_ID = 'UBOT';
    process.env.SLACK_BOT_TOKEN = 'xoxb-token';

    const config = resolveSlackBridgeConfig({
      require_mention: 'env:SLACK_REQUIRE_MENTION',
      bot_user_id: 'env:SLACK_BOT_USER_ID',
      bot_token: 'env:SLACK_BOT_TOKEN',
    });

    expect(config).toEqual({
      requireMention: true,
      botUserId: 'UBOT',
      botToken: 'xoxb-token',
    });
  });

  it('ignores Slack messages without mention when require_mention is enabled', () => {
    const config: SlackBridgeConfig = { requireMention: true, botUserId: 'UBOT', botToken: null };

    expect(shouldIgnoreSlackMessage({ type: 'message', channel: 'C1', user: 'U1', text: 'plain text' }, config)).toBe(true);
    expect(shouldIgnoreSlackMessage({ type: 'message', channel: 'C1', user: 'U1', text: 'hi <@UBOT>' }, config)).toBe(false);
  });

  it('normalizes Slack events into the canonical bridge shape', () => {
    const event: SlackMessageEvent = {
      type: 'message',
      channel: 'C1',
      user: 'U1',
      text: 'hello <@UBOT> there',
      ts: '1710000000.1',
      thread_ts: '1710000000.0',
    };

    expect(normalizeSlackEvent(event, 'T1', { requireMention: true, botUserId: 'UBOT', botToken: null }, 'Ev1')).toEqual({
      channelId: 'C1',
      userId: 'U1',
      eventId: 'Ev1',
      messageText: 'hello there',
      messageTs: '1710000000.1',
      threadTs: '1710000000.0',
      teamId: 'T1',
      raw: event,
    });
  });

  it('posts Slack rate-limit notices through chat.postMessage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } satisfies Partial<Response>);

    const sent = await postSlackRateLimitNotice('xoxb-token', { channel: 'C1', threadTs: '1710000000.0' }, fetchMock as typeof fetch);

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer xoxb-token' }),
    }));
  });
});

describe('BridgeInboundService', () => {
  beforeEach(() => resetBridgeRateLimiter());
  afterEach(() => resetBridgeRateLimiter());

  it('allows up to 60 requests per channel per minute', () => {
    for (let index = 0; index < 60; index += 1) {
      expect(checkChannelRateLimit('slack:C1')).toBe(true);
    }
    expect(checkChannelRateLimit('slack:C1')).toBe(false);
  });

  it('normalizes metadata with Slack timestamps', () => {
    const event: BridgeInboundEvent = {
      channelId: 'C1',
      userId: 'U1',
      eventId: 'Ev1',
      messageText: 'hello',
      messageTs: '1710000000.1',
      threadTs: '1710000000.0',
      teamId: 'T1',
      raw: {},
    };

    expect(normalizeBridgeMetadata('slack', event)).toEqual({
      source: 'slack',
      channel_id: 'C1',
      thread_ts: '1710000000.0',
      team_id: 'T1',
      event_id: 'Ev1',
      slack_ts: '1710000000.1',
    });
  });

  it('creates a memo with required metadata for a mapped Slack user', async () => {
    const { db, state } = createDbStub();
    const service = new BridgeInboundService(db);

    const result = await service.processInboundMessage({
      platform: 'slack',
      mapping: CHANNEL_MAPPING,
      event: {
        channelId: 'C1234',
        userId: 'U123',
        eventId: 'EvMapped',
        messageText: 'hello from slack',
        messageTs: '1710000000.000100',
        threadTs: '1710000000.000050',
        teamId: 'T123',
        raw: {},
      },
      unknownUserLabel: 'Slack 연동 미설정 사용자',
    });

    expect(result).toEqual({ action: 'created', memoId: 'memo-1' });
    expect(state.insertedMemos[0]).toEqual(expect.objectContaining({
      project_id: 'project-1',
      org_id: 'org-1',
      created_by: 'tm-1',
      memo_type: 'memo',
      content: 'hello from slack',
      metadata: {
        source: 'slack',
        channel_id: 'C1234',
        thread_ts: '1710000000.000050',
        slack_ts: '1710000000.000100',
        team_id: 'T123',
        event_id: 'EvMapped',
      },
    }));
  });

  it('uses a fallback author and labels unmapped users', async () => {
    const { db, state } = createDbStub({
      userData: null,
      projectScopedMemberData: { id: 'agent-1' },
      agentFallbackData: { id: 'agent-1' },
    });
    const service = new BridgeInboundService(db);

    const result = await service.processInboundMessage({
      platform: 'slack',
      mapping: CHANNEL_MAPPING,
      event: {
        channelId: 'C1234',
        userId: 'U999',
        eventId: 'EvFallback',
        messageText: 'who am i',
        messageTs: '1710000000.000200',
        threadTs: null,
        teamId: 'T123',
        raw: {},
      },
      unknownUserLabel: 'Slack 연동 미설정 사용자',
    });

    expect(result.action).toBe('created');
    expect(state.insertedMemos[0]).toEqual(expect.objectContaining({
      created_by: 'agent-1',
      title: '[Slack 연동 미설정 사용자] who am i',
      content: '[Slack 연동 미설정 사용자]\nslack_user_id: U999\n\nwho am i',
    }));
  });

  it('falls back when a mapped user is outside the current project scope', async () => {
    const { db, state } = createDbStub({
      userData: { team_member_id: 'tm-other-project', display_name: 'Elsewhere' },
      projectScopedMemberData: { id: 'agent-1' },
      agentFallbackData: { id: 'agent-1' },
    });
    const service = new BridgeInboundService(db);

    const result = await service.processInboundMessage({
      platform: 'slack',
      mapping: CHANNEL_MAPPING,
      event: {
        channelId: 'C1234',
        userId: 'U777',
        eventId: 'EvScopedFallback',
        messageText: 'scoped fallback',
        messageTs: '1710000000.000250',
        threadTs: null,
        teamId: 'T123',
        raw: {},
      },
      unknownUserLabel: 'Slack 연동 미설정 사용자',
    });

    expect(result.action).toBe('created');
    expect(state.insertedMemos[0]).toEqual(expect.objectContaining({
      created_by: 'agent-1',
      title: '[Slack 연동 미설정 사용자] scoped fallback',
    }));
  });

  it('ignores duplicate Slack retries when the memo insert hits the durable event id constraint', async () => {
    const { db, state } = createDbStub({
      existingMemoData: { id: 'memo-existing' },
      memoInsertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const service = new BridgeInboundService(db);

    const result = await service.processInboundMessage({
      platform: 'slack',
      mapping: CHANNEL_MAPPING,
      event: {
        channelId: 'C1234',
        userId: 'U123',
        eventId: 'EvDuplicate',
        messageText: 'duplicate retry',
        messageTs: '1710000000.000260',
        threadTs: null,
        teamId: 'T123',
        raw: {},
      },
      unknownUserLabel: 'Slack 연동 미설정 사용자',
    });

    expect(result).toEqual({ action: 'ignored', memoId: 'memo-existing' });
    expect(state.insertedMemos).toHaveLength(0);
  });

  it('returns rate_limited after the channel exceeds 60 events per minute', async () => {
    const { db } = createDbStub();
    const service = new BridgeInboundService(db);
    const event: BridgeInboundEvent = {
      channelId: 'C1234',
      userId: 'U123',
      eventId: null,
      messageText: 'flood',
      messageTs: '1710000000.000300',
      threadTs: null,
      teamId: 'T123',
      raw: {},
    };

    for (let index = 0; index < 60; index += 1) {
      await service.processInboundMessage({ platform: 'slack', mapping: CHANNEL_MAPPING, event, unknownUserLabel: 'Slack 연동 미설정 사용자' });
    }

    const result = await service.processInboundMessage({ platform: 'slack', mapping: CHANNEL_MAPPING, event, unknownUserLabel: 'Slack 연동 미설정 사용자' });
    expect(result).toEqual({ action: 'rate_limited' });
  });

  it('treats concurrent events independently', async () => {
    const { db, state } = createDbStub();
    const service = new BridgeInboundService(db);

    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => service.processInboundMessage({
      platform: 'slack',
      mapping: CHANNEL_MAPPING,
      event: {
        channelId: 'C1234',
        userId: `U${index}`,
        eventId: `Ev${index}`,
        messageText: `message ${index}`,
        messageTs: `1710000000.000${index}`,
        threadTs: null,
        teamId: 'T123',
        raw: {},
      },
      unknownUserLabel: 'Slack 연동 미설정 사용자',
    })));

    expect(results.every((result) => result.action === 'created')).toBe(true);
    expect(state.insertedMemos).toHaveLength(5);
  });
});
