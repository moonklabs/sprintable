import { describe, expect, it, vi } from 'vitest';
import {
  buildSlackConnectUrl,
  fetchSlackChannels,
  fetchSlackWorkspace,
  isExpiredIsoTimestamp,
  loadSlackConnectionSnapshot,
  resolveMessagingBridgeSecretRef,
  SlackApiError,
} from './slack-channel-mapping';

describe('slack-channel-mapping helpers', () => {
  it('builds the Slack OAuth authorize URL', () => {
    const url = buildSlackConnectUrl({
      clientId: '12345',
      redirectUri: 'https://app.example.com/api/integrations/slack/callback',
      state: 'opaque-state',
    });

    expect(url).toContain('https://slack.com/oauth/v2/authorize?');
    expect(url).toContain('client_id=12345');
    expect(url).toContain(encodeURIComponent('https://app.example.com/api/integrations/slack/callback'));
    expect(url).toContain('scope=channels%3Aread%2Cgroups%3Aread%2Cchat%3Awrite');
    expect(url).toContain('state=opaque-state');
  });

  it('resolves env secret refs and rejects expired timestamps', () => {
    process.env.TEST_SLACK_TOKEN = 'xoxb-token';
    expect(resolveMessagingBridgeSecretRef('env:TEST_SLACK_TOKEN')).toBe('xoxb-token');
    expect(resolveMessagingBridgeSecretRef('vault:kv/slack/token')).toBeNull();
    expect(isExpiredIsoTimestamp('2000-01-01T00:00:00.000Z')).toBe(true);
    expect(isExpiredIsoTimestamp('2999-01-01T00:00:00.000Z')).toBe(false);
    delete process.env.TEST_SLACK_TOKEN;
  });
});

describe('fetchSlackWorkspace', () => {
  it('returns the workspace summary from auth.test', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, team: 'Acme', team_id: 'T123', user_id: 'U999' }), { status: 200 }));
    await expect(fetchSlackWorkspace('xoxb-token', fetchFn as typeof fetch)).resolves.toEqual({
      teamName: 'Acme',
      teamId: 'T123',
      botUserId: 'U999',
    });
  });

  it('surfaces Slack API errors', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }));
    await expect(fetchSlackWorkspace('xoxb-token', fetchFn as typeof fetch)).rejects.toEqual(expect.objectContaining({
      name: 'SlackApiError',
      code: 'invalid_auth',
    } satisfies Partial<SlackApiError>));
  });
});

describe('fetchSlackChannels', () => {
  it('paginates, filters archived channels, and normalizes the result', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        channels: [
          { id: 'C2', name: 'design', is_private: false, is_member: true, num_members: 12 },
          { id: 'C3', name: 'archived', is_archived: true, is_private: false, is_member: false },
        ],
        response_metadata: { next_cursor: 'cursor-1' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        channels: [
          { id: 'C1', name: 'alerts', is_private: true, is_member: false, num_members: 3 },
        ],
        response_metadata: { next_cursor: '' },
      }), { status: 200 }));

    await expect(fetchSlackChannels('xoxb-token', fetchFn as typeof fetch)).resolves.toEqual([
      { id: 'C1', name: 'alerts', isPrivate: true, isMember: false, memberCount: 3 },
      { id: 'C2', name: 'design', isPrivate: false, isMember: true, memberCount: 12 },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('loadSlackConnectionSnapshot', () => {
  it('returns connected snapshot when workspace and channels both load', async () => {
    const fetchWorkspace = vi.fn(async () => ({ teamName: 'Acme', teamId: 'T1', botUserId: 'U1' }));
    const fetchChannels = vi.fn(async () => ([
      { id: 'C1', name: 'alerts', isPrivate: false, isMember: true, memberCount: 5 },
    ]));

    await expect(loadSlackConnectionSnapshot('xoxb-token', { fetchWorkspace, fetchChannels })).resolves.toEqual({
      status: 'connected',
      workspace: { teamName: 'Acme', teamId: 'T1', botUserId: 'U1' },
      channels: [{ id: 'C1', name: 'alerts', isPrivate: false, isMember: true, memberCount: 5 }],
      error: null,
    });
  });

  it('keeps the workspace summary when channel loading fails', async () => {
    const fetchWorkspace = vi.fn(async () => ({ teamName: 'Acme', teamId: 'T1', botUserId: 'U1' }));
    const fetchChannels = vi.fn(async () => {
      throw new SlackApiError('missing_scope', 'Slack channel permissions are missing');
    });

    await expect(loadSlackConnectionSnapshot('xoxb-token', { fetchWorkspace, fetchChannels })).resolves.toEqual({
      status: 'channel_fetch_error',
      workspace: { teamName: 'Acme', teamId: 'T1', botUserId: 'U1' },
      channels: [],
      error: {
        code: 'missing_scope',
        message: 'Slack channel permissions are missing',
      },
    });
  });
});
