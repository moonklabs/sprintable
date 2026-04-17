import type { BridgeInboundEvent } from './bridge-inbound';
import { resolveTeamsBridgeConfig } from './teams-bridge-utils';

interface TeamsJwtHeader {
  alg?: string;
  kid?: string;
}

interface TeamsJwtPayload {
  iss?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
  serviceurl?: string;
}

interface TeamsOpenIdConfig {
  issuer: string;
  jwks_uri: string;
}

interface TeamsJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface TeamsJwksResponse {
  keys: TeamsJwk[];
}

export interface TeamsActivityEntity {
  type?: string;
  mentioned?: { id?: string };
}

export interface TeamsActivity {
  id?: string;
  type?: string;
  text?: string;
  textFormat?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: {
    team?: { id?: string };
    channel?: { id?: string };
    tenant?: { id?: string };
  };
  entities?: TeamsActivityEntity[];
}

export interface TeamsInboundConfig {
  botAppId: string | null;
}

const OPENID_CONFIG_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const JWKS_CACHE_TTL_MS = 10 * 60_000;

let cachedConfig: { value: TeamsOpenIdConfig; fetchedAt: number } | null = null;
let cachedJwks: { value: TeamsJwk[]; fetchedAt: number; uri: string } | null = null;

function stripHtml(raw: string) {
  return raw
    .replace(/<at[^>]*>/gi, '')
    .replace(/<\/at>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBase64Url(input: string) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = globalThis.atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(input))) as T;
}

function parseBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  return authorizationHeader.slice('Bearer '.length).trim();
}

function normalizeUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url).toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}

async function fetchOpenIdConfig(fetchFn: typeof fetch) {
  if (cachedConfig && Date.now() - cachedConfig.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedConfig.value;
  }

  const response = await fetchFn(OPENID_CONFIG_URL);
  if (!response.ok) throw new Error(`teams_openid_config_failed_${response.status}`);
  const value = await response.json() as TeamsOpenIdConfig;
  cachedConfig = { value, fetchedAt: Date.now() };
  return value;
}

async function fetchJwks(uri: string, fetchFn: typeof fetch) {
  if (cachedJwks && cachedJwks.uri === uri && Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks.value;
  }

  const response = await fetchFn(uri);
  if (!response.ok) throw new Error(`teams_jwks_failed_${response.status}`);
  const json = await response.json() as TeamsJwksResponse;
  cachedJwks = { value: json.keys, fetchedAt: Date.now(), uri };
  return json.keys;
}

async function verifyJwtSignature(token: string, key: TeamsJwk) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) return false;

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'jwk',
    {
      kty: key.kty,
      n: key.n,
      e: key.e,
      alg: 'RS256',
      ext: true,
    },
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify'],
  );

  return globalThis.crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
}

export function resolveTeamsInboundConfig(config: Record<string, string> | null | undefined) {
  return resolveTeamsBridgeConfig(config);
}

export function getTeamsSourceChannelId(activity: TeamsActivity) {
  return activity.channelData?.channel?.id ?? activity.conversation?.id ?? null;
}

export function getTeamsConversationId(activity: TeamsActivity) {
  return activity.conversation?.id ?? null;
}

export function shouldIgnoreTeamsActivity(activity: TeamsActivity) {
  if (activity.type !== 'message') return true;
  if (!activity.from?.id || !activity.conversation?.id) return true;
  if (activity.from.id === activity.recipient?.id) return true;
  return false;
}

export function normalizeTeamsActivity(activity: TeamsActivity): BridgeInboundEvent {
  return {
    channelId: getTeamsSourceChannelId(activity) ?? activity.conversation?.id ?? 'unknown-channel',
    userId: activity.from?.id ?? null,
    eventId: activity.id ?? null,
    messageText: stripHtml(activity.text ?? ''),
    messageTs: activity.id ?? null,
    threadTs: getTeamsConversationId(activity),
    teamId: activity.channelData?.team?.id ?? activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? null,
    raw: activity,
  };
}

export async function verifyTeamsRequest(input: {
  authorizationHeader: string | null;
  serviceUrl: string | null | undefined;
  botAppId: string | null | undefined;
  fetchFn?: typeof fetch;
  nowMs?: number;
}) {
  const token = parseBearerToken(input.authorizationHeader);
  if (!token || !input.botAppId || !input.serviceUrl) return false;

  const [encodedHeader, encodedPayload] = token.split('.');
  if (!encodedHeader || !encodedPayload) return false;
  const header = decodeJson<TeamsJwtHeader>(encodedHeader);
  const payload = decodeJson<TeamsJwtPayload>(encodedPayload);
  if (header.alg !== 'RS256' || !header.kid) return false;

  const fetchFn = input.fetchFn ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const openIdConfig = await fetchOpenIdConfig(fetchFn);
  const jwks = await fetchJwks(openIdConfig.jwks_uri, fetchFn);
  const key = jwks.find((candidate) => candidate.kid === header.kid);
  if (!key) return false;

  const verified = await verifyJwtSignature(token, key);
  if (!verified) return false;

  const nowSeconds = Math.floor(nowMs / 1000);
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + 60) return false;
  if (typeof payload.exp === 'number' && payload.exp < nowSeconds - 60) return false;
  if (payload.iss !== openIdConfig.issuer) return false;
  if (payload.aud !== input.botAppId) return false;

  const expectedServiceUrl = normalizeUrl(input.serviceUrl);
  const actualServiceUrl = normalizeUrl(payload.serviceurl);
  if (!expectedServiceUrl || !actualServiceUrl) return false;
  if (expectedServiceUrl !== actualServiceUrl) return false;
  return true;
}
