import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { generateApiKey } from '@/lib/auth-api-key';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, ADMIN_ROLES } from '@/lib/role-guard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

/**
 * POST /api/api-keys/rotate
 * 새 API Key 발급 + 기존 키 revoked_at 설정 (원자적 교체)
 * Body: { api_key_id: string }
 */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'API key rotation is not supported in OSS mode.', 501);
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (me.type !== 'agent') {
      const denied = await requireRole(supabase, me.org_id, ADMIN_ROLES, 'Admin access required to rotate API keys');
      if (denied) return denied;
    }

    const { api_key_id } = await request.json() as { api_key_id: string };
    if (!api_key_id) return apiError('BAD_REQUEST', 'api_key_id required', 400);

    const admin = (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient());

    // 기존 키 조회 + org 확인
    const { data: existing } = await admin
      .from('agent_api_keys')
      .select('id, team_member_id, expires_at, scope, team_members(org_id)')
      .eq('id', api_key_id)
      .is('revoked_at', null)
      .maybeSingle();

    if (!existing) return ApiErrors.notFound('API key not found or already revoked');

    const teamMember = Array.isArray(existing.team_members) ? existing.team_members[0] : existing.team_members;
    if ((teamMember as { org_id: string } | null)?.org_id !== me.org_id) {
      return ApiErrors.forbidden('Cannot rotate API key from different org');
    }

    // 기존 키 revoke
    const revokedAt = new Date().toISOString();
    await admin.from('agent_api_keys').update({ revoked_at: revokedAt }).eq('id', api_key_id);

    // 새 키 발급 (동일 agent + scope + expiry 유지)
    const { apiKey, keyPrefix, keyHash } = generateApiKey();
    const defaultExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: newKey, error: insertError } = await admin
      .from('agent_api_keys')
      .insert({
        team_member_id: existing.team_member_id,
        key_prefix: keyPrefix,
        key_hash: keyHash,
        expires_at: existing.expires_at ?? defaultExpiry,
        scope: existing.scope,
      })
      .select('id, key_prefix, created_at, expires_at, scope')
      .single();

    if (insertError || !newKey) throw insertError ?? new Error('Failed to create new API key');

    return apiSuccess({ id: newKey.id, key_prefix: newKey.key_prefix, created_at: newKey.created_at, api_key: apiKey });
  } catch (err: unknown) { return handleApiError(err); }
}
