import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_MAX_AGE_SECONDS = 60 * 10;

export interface McpOAuthStatePayload {
  orgId: string;
  projectId: string;
  actorId: string;
  serverKey: string;
  issuedAt: number;
}

function getSigningSecret() {
  const secret = process.env['MCP_CONNECTION_STATE_SECRET']?.trim() || process.env['INTERNAL_DOGFOOD_ACCESS_SECRET']?.trim();
  if (!secret) {
    throw new Error('mcp_connection_state_secret_missing');
  }
  return secret;
}

function signValue(value: string) {
  return createHmac('sha256', getSigningSecret()).update(value).digest('base64url');
}

export function encodeMcpOAuthState(payload: McpOAuthStatePayload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function decodeMcpOAuthState(token: string | null | undefined) {
  if (!token) return null;

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expected = signValue(encodedPayload);
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as McpOAuthStatePayload;
    if (!payload.orgId || !payload.projectId || !payload.actorId || !payload.serverKey || !payload.issuedAt) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const maxAgeSeconds = Number(process.env['MCP_CONNECTION_STATE_MAX_AGE_SECONDS'] ?? DEFAULT_MAX_AGE_SECONDS);
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
    if (payload.issuedAt > now + 60) return null;
    if (payload.issuedAt < now - maxAgeSeconds) return null;

    return payload;
  } catch {
    return null;
  }
}
