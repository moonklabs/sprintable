import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const INTERNAL_DOGFOOD_COOKIE = 'sprintable_internal_dogfood';
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 12;
const DEFAULT_INTERNAL_DOGFOOD_ORG_ID = '54bac162-5c0d-49fa-8e49-85977063a091';
const DEFAULT_INTERNAL_DOGFOOD_PROJECT_ID = 'f3e6ed64-447d-4b1c-ad78-a00cfba715a7';
const DEFAULT_INTERNAL_DOGFOOD_PROJECT_NAME = 'Sprintable';

export interface InternalDogfoodSessionPayload {
  teamMemberId: string;
  orgId: string;
  projectId: string;
  issuedAt: number;
}

export interface InternalDogfoodActor {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  project_name: string;
}

function getSigningSecret() {
  const secret = process.env['INTERNAL_DOGFOOD_ACCESS_SECRET']?.trim();
  if (!secret) throw new Error('internal_dogfood_access_secret_missing');
  return secret;
}

function getFallbackOrgId() {
  return process.env['INTERNAL_DOGFOOD_DEFAULT_ORG_ID']?.trim() || DEFAULT_INTERNAL_DOGFOOD_ORG_ID;
}

function getFallbackProjectId() {
  return process.env['INTERNAL_DOGFOOD_DEFAULT_PROJECT_ID']?.trim() || DEFAULT_INTERNAL_DOGFOOD_PROJECT_ID;
}

function getFallbackProjectName() {
  return process.env['INTERNAL_DOGFOOD_DEFAULT_PROJECT_NAME']?.trim() || DEFAULT_INTERNAL_DOGFOOD_PROJECT_NAME;
}

export function isInternalDogfoodEnabled() {
  return process.env['INTERNAL_DOGFOOD_ACCESS_ENABLED'] === 'true';
}

export function getInternalDogfoodAllowedTeamMemberIds() {
  return (process.env['INTERNAL_DOGFOOD_TEAM_MEMBER_IDS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getInternalDogfoodActors(): InternalDogfoodActor[] {
  return getInternalDogfoodAllowedTeamMemberIds().map((id) => ({
    id,
    org_id: getFallbackOrgId(),
    project_id: getFallbackProjectId(),
    name: id,
    project_name: getFallbackProjectName(),
  }));
}

export function resolveInternalDogfoodActor(teamMemberId: string) {
  return getInternalDogfoodActors().find((actor) => actor.id === teamMemberId) ?? null;
}

function signValue(value: string) {
  return createHmac('sha256', getSigningSecret()).update(value).digest('base64url');
}

export function encodeInternalDogfoodSession(payload: InternalDogfoodSessionPayload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function decodeInternalDogfoodSession(token: string | null | undefined): InternalDogfoodSessionPayload | null {
  if (!token) return null;

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = signValue(encodedPayload);
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as InternalDogfoodSessionPayload;
    if (!payload.teamMemberId || !payload.orgId || !payload.projectId || !payload.issuedAt) return null;

    const now = Math.floor(Date.now() / 1000);
    const maxAgeSeconds = Number(process.env['INTERNAL_DOGFOOD_ACCESS_MAX_AGE_SECONDS'] ?? DEFAULT_MAX_AGE_SECONDS);
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
    if (payload.issuedAt > now + 60) return null;
    if (payload.issuedAt < now - maxAgeSeconds) return null;

    return payload;
  } catch {
    return null;
  }
}

export async function readInternalDogfoodSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(INTERNAL_DOGFOOD_COOKIE)?.value;
  return decodeInternalDogfoodSession(token);
}
