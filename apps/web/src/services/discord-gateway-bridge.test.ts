import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordGatewayBridge } from './discord-gateway-bridge';

function createSocket() {
  return {
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as ((event: { code?: number; reason?: string }) => void) | null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe('DiscordGatewayBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('normalizes threaded Discord messages through the parent channel mapping', async () => {
    const socket = createSocket();
    const socketFactory = vi.fn(() => socket);
    const findChannelMapping = vi.fn(async () => ({ id: 'mapping-1', org_id: 'org-1', project_id: 'project-1', config: {} }));
    const processInboundMessage = vi.fn(async () => ({ action: 'processed' }));

    const bridge = new DiscordGatewayBridge({
      supabase: {} as never,
      orgId: 'org-1',
      token: 'discord-token',
      socketFactory,
      inboundService: { findChannelMapping, processInboundMessage } as never,
      logger: console,
    });

    bridge.start();
    socket.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 15_000 } }) });
    socket.onmessage?.({ data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: 'bot-1' }, session_id: 'session-1' } }) });
    socket.onmessage?.({
      data: JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 2,
        d: {
          id: 'message-1',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: '<@bot-1> 부탁드리는',
          author: { id: 'human-1', username: 'qasim' },
          thread: { id: 'thread-1', parent_id: 'channel-parent-1' },
        },
      }),
    });
    await Promise.resolve();

    expect(findChannelMapping).toHaveBeenCalledWith('discord', 'channel-parent-1');
    expect(processInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        channelId: 'channel-parent-1',
        threadTs: 'thread-1',
      }),
    }));
  });

  it('resumes the gateway session after a reconnect opcode instead of sending a fresh identify', async () => {
    const firstSocket = createSocket();
    const secondSocket = createSocket();
    const socketFactory = vi.fn()
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);

    const bridge = new DiscordGatewayBridge({
      supabase: {} as never,
      orgId: 'org-1',
      token: 'discord-token',
      socketFactory,
      inboundService: { findChannelMapping: vi.fn(), processInboundMessage: vi.fn() } as never,
      logger: console,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 100,
    });

    bridge.start();
    firstSocket.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 15_000 } }) });
    firstSocket.onmessage?.({ data: JSON.stringify({ op: 0, t: 'READY', s: 10, d: { user: { id: 'bot-1' }, session_id: 'session-1' } }) });
    firstSocket.onmessage?.({ data: JSON.stringify({ op: 7, d: null }) });

    await vi.advanceTimersByTimeAsync(100);
    secondSocket.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 15_000 } }) });

    const resumePayload = JSON.parse(String(secondSocket.send.mock.calls[1]?.[0] ?? secondSocket.send.mock.calls[0]?.[0]));
    expect(resumePayload).toMatchObject({
      op: 6,
      d: {
        token: 'discord-token',
        session_id: 'session-1',
        seq: 10,
      },
    });
  });

  it('resumes after a plain socket close when session and seq are already known', async () => {
    const firstSocket = createSocket();
    const secondSocket = createSocket();
    const socketFactory = vi.fn()
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);

    const bridge = new DiscordGatewayBridge({
      supabase: {} as never,
      orgId: 'org-1',
      token: 'discord-token',
      socketFactory,
      inboundService: { findChannelMapping: vi.fn(), processInboundMessage: vi.fn() } as never,
      logger: console,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 100,
    });

    bridge.start();
    firstSocket.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 15_000 } }) });
    firstSocket.onmessage?.({ data: JSON.stringify({ op: 0, t: 'READY', s: 42, d: { user: { id: 'bot-1' }, session_id: 'session-plain-close' } }) });
    firstSocket.onclose?.({ code: 1006, reason: 'network reset' });

    await vi.advanceTimersByTimeAsync(100);
    secondSocket.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 15_000 } }) });

    const sentPayloads = secondSocket.send.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(sentPayloads).toContainEqual(expect.objectContaining({
      op: 6,
      d: expect.objectContaining({
        token: 'discord-token',
        session_id: 'session-plain-close',
        seq: 42,
      }),
    }));
    expect(sentPayloads).not.toContainEqual(expect.objectContaining({ op: 2 }));
  });

  it('reports auth_failed on gateway close 4004', async () => {
    const socket = createSocket();
    const socketFactory = vi.fn(() => socket);
    const onAuthFailed = vi.fn();

    const bridge = new DiscordGatewayBridge({
      supabase: {} as never,
      orgId: 'org-1',
      token: 'discord-token',
      socketFactory,
      inboundService: { findChannelMapping: vi.fn(), processInboundMessage: vi.fn() } as never,
      logger: console,
      onAuthFailed,
    });

    bridge.start();
    socket.onclose?.({ code: 4004, reason: 'Authentication failed' });

    expect(onAuthFailed).toHaveBeenCalledWith('org-1', 'auth_failed');
  });
});
