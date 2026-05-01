import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

import { POST } from './route';

function makeSignature(secret: string, timestamp: string, body: string) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

function createDbStub(channelData: unknown) {
  const resolveSingle = (table: string) => {
    if (table === 'messaging_bridge_channels') {
      return { data: channelData, error: null };
    }
    if (table === 'projects') {
      return { data: { id: 'project-1', org_id: 'org-1' }, error: null };
    }
    if (table === 'messaging_bridge_users') {
      return { data: { team_member_id: 'tm-1', display_name: 'Alice' }, error: null };
    }
    if (table === 'memos') {
      return { data: { id: 'memo-1' }, error: null };
    }
    return { data: null, error: null };
  };

  const createQuery = (table: string) => {
    const query = {
      select: vi.fn(() => query),
      insert: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => resolveSingle(table)),
      single: vi.fn(async () => resolveSingle(table)),
    };

    return query;
  };

  return {
    from(table: string) {
      return createQuery(table);
    },
  };
}

function makeRequest(body: Record<string, unknown>, opts?: { signature?: string; timestamp?: string }) {
  const rawBody = JSON.stringify(body);
  const timestamp = opts?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts?.signature ?? makeSignature(process.env.SLACK_SIGNING_SECRET!, timestamp, rawBody);

  return new Request('http://localhost/api/v1/bridge/slack/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body: rawBody,
  });
}

describe('POST /api/v1/bridge/slack/events', () => {
  beforeEach(() => {
    createClient.mockReset();
    process.env.SLACK_SIGNING_SECRET = 'route-signing-secret';
    process.env.DATABASE_URL = 'https://example.db.co';
    process.env.DATABASE_SERVICE_KEY = 'service-role-key';
  });

  it('returns 401 when the Slack signature is invalid', async () => {
    const response = await POST(makeRequest(
      {
        type: 'event_callback',
        team_id: 'T123',
        event: { type: 'message', channel: 'C1234', user: 'U123', text: 'hello', ts: '1710000000.1' },
      },
      { signature: 'v0=deadbeef' },
    ));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns the Slack challenge for url_verification requests', async () => {
    const response = await POST(makeRequest({
      type: 'url_verification',
      challenge: 'challenge-token',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'challenge-token' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('acknowledges unmapped channels with 200 and ignores the event', async () => {
    createClient.mockReturnValue(createDbStub(null));

    const response = await POST(makeRequest({
      type: 'event_callback',
      team_id: 'T123',
      event: { type: 'message', channel: 'C1234', user: 'U123', text: 'hello', ts: '1710000000.1' },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ action: 'ignored' });
    expect(createClient).toHaveBeenCalledWith('https://example.db.co', 'service-role-key');
  });
});
