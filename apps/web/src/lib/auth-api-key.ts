// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { createHash } from 'crypto';

export class RevokedApiKeyError extends Error {
  constructor(message = 'API key has been revoked') {
    super(message);
    this.name = 'RevokedApiKeyError';
  }
}

export interface TeamMemberContext {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  type: 'human' | 'agent';
  scope?: string[];
  apiKeyId?: string;
}

/**
 * API Key를 SHA-256 해싱
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * API Key 생성 (sk_live_<random 32 chars>)
 */
export function generateApiKey(): { apiKey: string; keyPrefix: string; keyHash: string } {
  const randomPart = Array.from({ length: 32 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]
  ).join('');

  const apiKey = `sk_live_${randomPart}`;
  const keyPrefix = apiKey.slice(0, 15); // "sk_live_abcdefg"
  const keyHash = hashApiKey(apiKey);

  return { apiKey, keyPrefix, keyHash };
}

/**
 * Authorization 헤더에서 Bearer 토큰 추출
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match?.[1] ?? null;
}

/**
 * API Key로 team_member 인증
 *
 * @param adminClient - Service role client (RLS 우회용)
 * @param apiKey - Bearer 토큰으로 받은 API Key
 * @returns team_member context 또는 null (인증 실패)
 */
export async function getTeamMemberFromApiKey(
  adminClient: SupabaseClient,
  apiKey: string,
  logContext?: { endpoint: string; ip?: string | null },
): Promise<TeamMemberContext | null> {
  const keyHash = hashApiKey(apiKey);

  // 1. API Key 조회 (revoked 포함 — 명시적 오류 반환 위해)
  const { data: apiKeyRow, error: keyError } = await adminClient
    .from('agent_api_keys')
    .select('id, team_member_id, revoked_at, expires_at, scope')
    .eq('key_hash', keyHash)
    .maybeSingle();

  if (keyError || !apiKeyRow) return null;

  // revoked 키 명시적 거부
  if (apiKeyRow.revoked_at) throw new RevokedApiKeyError();

  // 만료 키 거부 (expires_at=NULL이면 무기한 유효)
  if (apiKeyRow.expires_at && new Date(apiKeyRow.expires_at) < new Date()) return null;

  // AC6: scope=NULL이면 ['read','write'] 기본값 적용 (admin 제외 하위호환)
  const scope: string[] = (apiKeyRow.scope as string[] | null) ?? ['read', 'write'];

  // 2. team_member 조회
  const { data: member, error: memberError } = await adminClient
    .from('team_members')
    .select('id, org_id, project_id, name, type, is_active')
    .eq('id', apiKeyRow.team_member_id)
    .eq('is_active', true)
    .maybeSingle();

  if (memberError || !member) return null;

  // 3. last_used_at 업데이트 + 사용 로그 (fire-and-forget)
  const now = new Date().toISOString();
  void adminClient.from('agent_api_keys').update({ last_used_at: now }).eq('id', apiKeyRow.id);
  if (logContext) {
    void adminClient.from('api_key_logs').insert({
      api_key_id: apiKeyRow.id as string,
      org_id: member.org_id as string,
      endpoint: logContext.endpoint,
      ip_address: logContext.ip ?? null,
    });
  }

  return {
    id: member.id as string,
    org_id: member.org_id as string,
    project_id: member.project_id as string,
    name: member.name as string,
    type: member.type as 'human' | 'agent',
    scope,
    apiKeyId: apiKeyRow.id as string,
  };
}

/**
 * Request에서 Authorization 헤더를 파싱해서 API Key 인증 시도
 *
 * @param adminClient - Service role client (RLS 우회용)
 * @param request - HTTP Request
 */
/**
 * Scope 검증 헬퍼 — agent API key의 scope가 required를 포함하는지 확인
 * 사람(human) 인증에는 scope 제한 없음
 */
export function requireAgentScope(
  me: { type?: string; scope?: string[] } | null | undefined,
  required: string,
): boolean {
  if (!me || me.type !== 'agent') return true; // 사람 또는 미인증은 caller가 별도 처리
  return (me.scope ?? ['read', 'write']).includes(required);
}

export async function getTeamMemberFromRequest(
  adminClient: SupabaseClient,
  request: Request
): Promise<TeamMemberContext | null> {
  const authHeader = request.headers.get('Authorization');
  const apiKey = extractBearerToken(authHeader);

  if (!apiKey) {
    return null;
  }

  return getTeamMemberFromApiKey(adminClient, apiKey);
}
