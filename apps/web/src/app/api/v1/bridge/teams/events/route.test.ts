import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock, findChannelMapping, processInboundMessage, verifyTeamsRequestMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  findChannelMapping: vi.fn(),
  processInboundMessage: vi.fn(),
  verifyTeamsRequestMock: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
vi.mock('@/services/bridge-inbound', () => ({
  BridgeInboundService: class BridgeInboundService {
    findChannelMapping = findChannelMapping;
    processInboundMessage = processInboundMessage;
  },
}));
vi.mock('@/services/teams-inbound', async () => {
  const actual = await vi.importActual<typeof import('@/services/teams-inbound')>('@/services/teams-inbound');
  return {
    ...actual,
    verifyTeamsRequest: verifyTeamsRequestMock,
  };
});

import { POST } from './route';

describe('POST /api/v1/bridge/teams/events', () => {
  beforeEach(() => {
    createClientMock.mockReset();
    findChannelMapping.mockReset();
    processInboundMessage.mockReset();
    verifyTeamsRequestMock.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('skips unmapped teams channels without failing the webhook', async () => {
    createClientMock.mockReturnValue({});
    findChannelMapping.mockResolvedValue(null);

    const response = await POST(new Request('http://localhost/api/v1/bridge/teams/events', {
      method: 'POST',
      body: JSON.stringify({
        type: 'message',
        id: 'activity-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'user-1' },
        recipient: { id: 'bot-1' },
        conversation: { id: 'conversation-1' },
        channelData: { channel: { id: 'channel-1' } },
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ skipped: 'channel_not_mapped' });
  });

  it('returns 401 when the Teams JWT is invalid', async () => {
    createClientMock.mockReturnValue({});
    findChannelMapping.mockResolvedValue({ id: 'mapping-1', config: { bot_app_id: 'teams-app-id' } });
    verifyTeamsRequestMock.mockResolvedValue(false);

    const response = await POST(new Request('http://localhost/api/v1/bridge/teams/events', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid' },
      body: JSON.stringify({
        type: 'message',
        id: 'activity-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'user-1' },
        recipient: { id: 'bot-1' },
        conversation: { id: 'conversation-1' },
        channelData: { channel: { id: 'channel-1' } },
      }),
    }));

    expect(response.status).toBe(401);
  });

  it('processes verified Teams message activities through BridgeInboundService', async () => {
    createClientMock.mockReturnValue({});
    findChannelMapping.mockResolvedValue({ id: 'mapping-1', config: { bot_app_id: 'teams-app-id' } });
    verifyTeamsRequestMock.mockResolvedValue(true);
    processInboundMessage.mockResolvedValue({ action: 'processed' });

    const response = await POST(new Request('http://localhost/api/v1/bridge/teams/events', {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: JSON.stringify({
        type: 'message',
        id: 'activity-1',
        text: '<p>Hello</p>',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'user-1', name: 'Alice' },
        recipient: { id: 'bot-1' },
        conversation: { id: 'conversation-1', tenantId: 'tenant-1' },
        channelData: { channel: { id: 'channel-1' }, team: { id: 'team-1' }, tenant: { id: 'tenant-1' } },
      }),
    }));

    expect(response.status).toBe(200);
    expect(processInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'teams',
      event: expect.objectContaining({
        channelId: 'channel-1',
        threadTs: 'conversation-1',
        messageText: 'Hello',
      }),
    }));
  });
});
