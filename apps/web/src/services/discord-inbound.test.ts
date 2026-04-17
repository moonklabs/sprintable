import { describe, expect, it, vi } from 'vitest';
import {
  DISCORD_RATE_LIMIT_NOTICE,
  getDiscordSourceChannelId,
  getDiscordThreadId,
  normalizeDiscordEvent,
  postDiscordRateLimitNotice,
  resolveDiscordBridgeConfig,
  shouldIgnoreDiscordMessage,
} from './discord-inbound';

describe('discord inbound helpers', () => {
  it('resolves mention-required bridge config from env secret refs', () => {
    process.env.DISCORD_REQUIRE_MENTION = 'true';
    process.env.DISCORD_BOT_USER_ID = 'bot-1';

    expect(resolveDiscordBridgeConfig({
      require_mention: 'env:DISCORD_REQUIRE_MENTION',
      bot_user_id: 'env:DISCORD_BOT_USER_ID',
    })).toEqual({
      requireMention: true,
      botUserId: 'bot-1',
    });
  });

  it('ignores bot messages and messages without a bot mention when mention is required', () => {
    expect(shouldIgnoreDiscordMessage({
      id: 'msg-1',
      channel_id: 'channel-1',
      content: 'hello',
      author: { id: 'bot-user', bot: true },
    }, { requireMention: false, botUserId: 'bot-1' })).toBe(true);

    expect(shouldIgnoreDiscordMessage({
      id: 'msg-2',
      channel_id: 'channel-1',
      content: 'plain text',
      author: { id: 'human-1' },
    }, { requireMention: true, botUserId: 'bot-1' })).toBe(true);
  });

  it('uses the parent channel id for threaded Discord messages', () => {
    const event = {
      id: 'msg-3',
      channel_id: 'thread-1',
      guild_id: 'guild-1',
      content: '<@bot-1> 부탁드리는',
      author: { id: 'human-1', username: 'qasim' },
      thread: { id: 'thread-1', parent_id: 'channel-parent-1' },
    };

    expect(getDiscordSourceChannelId(event)).toBe('channel-parent-1');
    expect(getDiscordThreadId(event)).toBe('thread-1');
    expect(normalizeDiscordEvent(event, { requireMention: true, botUserId: 'bot-1' })).toEqual({
      channelId: 'channel-parent-1',
      userId: 'human-1',
      eventId: 'msg-3',
      messageText: '부탁드리는',
      messageTs: 'msg-3',
      threadTs: 'thread-1',
      teamId: 'guild-1',
      raw: expect.any(Object),
    });
  });

  it('posts a rate-limit notice through Discord REST', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const ok = await postDiscordRateLimitNotice('bot-token', { channelId: 'channel-1' }, fetchFn as typeof fetch);

    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bot bot-token' }),
      }),
    );
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ content: DISCORD_RATE_LIMIT_NOTICE });
  });
});
