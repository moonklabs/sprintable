import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTeamsConversationId,
  getTeamsSourceChannelId,
  normalizeTeamsActivity,
  shouldIgnoreTeamsActivity,
  verifyTeamsRequest,
} from './teams-inbound';

function toBase64Url(input: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createSignedJwt(payload: Record<string, unknown>) {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey;
  const header = { alg: 'RS256', kid: 'kid-1' };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  return {
    token: `${encodedHeader}.${encodedPayload}.${toBase64Url(signature)}`,
    jwk: {
      kty: publicJwk.kty!,
      kid: 'kid-1',
      n: publicJwk.n!,
      e: publicJwk.e!,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

describe('teams inbound helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts source channel and conversation ids from Teams channel activities', () => {
    const activity = {
      id: 'activity-1',
      type: 'message',
      text: '<p>Hello</p>',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'user-1', name: 'Alice' },
      recipient: { id: 'bot-1', name: 'Bot' },
      conversation: { id: 'conversation-1', tenantId: 'tenant-1' },
      channelData: {
        channel: { id: 'channel-1' },
        team: { id: 'team-1' },
        tenant: { id: 'tenant-1' },
      },
    };

    expect(getTeamsSourceChannelId(activity)).toBe('channel-1');
    expect(getTeamsConversationId(activity)).toBe('conversation-1');
    expect(shouldIgnoreTeamsActivity(activity)).toBe(false);
    expect(normalizeTeamsActivity(activity)).toEqual(expect.objectContaining({
      channelId: 'channel-1',
      threadTs: 'conversation-1',
      messageText: 'Hello',
      teamId: 'team-1',
    }));
  });

  it('verifies a Bot Framework JWT against the published JWKS', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwk } = await createSignedJwt({
      iss: 'https://api.botframework.com',
      aud: 'teams-app-id',
      serviceurl: 'https://smba.trafficmanager.net/amer',
      exp: nowSeconds + 300,
      nbf: nowSeconds - 60,
    });

    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://api.botframework.com',
        jwks_uri: 'https://login.botframework.com/keys',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));

    const ok = await verifyTeamsRequest({
      authorizationHeader: `Bearer ${token}`,
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      botAppId: 'teams-app-id',
      fetchFn: fetchFn as typeof fetch,
    });

    expect(ok).toBe(true);
  });

  it('rejects JWTs when the audience does not match the Teams bot app id', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwk } = await createSignedJwt({
      iss: 'https://api.botframework.com',
      aud: 'other-app-id',
      serviceurl: 'https://smba.trafficmanager.net/amer',
      exp: nowSeconds + 300,
      nbf: nowSeconds - 60,
    });

    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://api.botframework.com',
        jwks_uri: 'https://login.botframework.com/keys',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));

    const ok = await verifyTeamsRequest({
      authorizationHeader: `Bearer ${token}`,
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      botAppId: 'teams-app-id',
      fetchFn: fetchFn as typeof fetch,
    });

    expect(ok).toBe(false);
  });

  it('rejects JWTs when the signed serviceurl claim is missing', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwk } = await createSignedJwt({
      iss: 'https://api.botframework.com',
      aud: 'teams-app-id',
      exp: nowSeconds + 300,
      nbf: nowSeconds - 60,
    });

    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://api.botframework.com',
        jwks_uri: 'https://login.botframework.com/keys',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));

    const ok = await verifyTeamsRequest({
      authorizationHeader: `Bearer ${token}`,
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      botAppId: 'teams-app-id',
      fetchFn: fetchFn as typeof fetch,
    });

    expect(ok).toBe(false);
  });
});
