import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const OSS_SESSION_COOKIE = 'sp_oss_at';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getSecret(): Uint8Array {
  const s = process.env['OSS_SESSION_SECRET'] ?? 'sprintable-oss-dev-secret-change-in-prod';
  return new TextEncoder().encode(s);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const derived = scryptSync(password, salt, 64);
    return timingSafeEqual(derived, Buffer.from(hash, 'hex'));
  } catch { return false; }
}

export async function signOssSession(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, type: 'oss_access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyOssSession(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload['type'] !== 'oss_access' || !payload.sub) return null;
    return { userId: payload.sub };
  } catch { return null; }
}

export function ossSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}
