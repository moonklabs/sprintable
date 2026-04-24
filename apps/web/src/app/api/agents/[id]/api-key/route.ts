import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { generateApiKey } from '@/lib/auth-api-key';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode, createAgentApiKeyRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/agents/[id]/api-key
 * 에이전트에게 API Key 발급
 *
 * Admin만 가능
 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id: teamMemberId } = await params;
      const { apiKey, keyPrefix, keyHash } = generateApiKey();
      const repo = await createAgentApiKeyRepository();
      const row = await repo.create({ teamMemberId, keyPrefix, keyHash });
      return apiSuccess({ ...row, api_key: apiKey }, undefined, 201);
    } catch (err: unknown) { return handleApiError(err); }
  }
  try {
    const { id: teamMemberId } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    // Admin 권한 확인
    const { data: myMember } = await supabase
      .from('team_members')
      .select('role')
      .eq('id', me.id)
      .single();

    if (!myMember || !['owner', 'admin'].includes(myMember.role)) {
      return ApiErrors.forbidden('Admin only');
    }

    // 대상 team_member가 agent인지 확인
    const { data: targetMember } = await supabase
      .from('team_members')
      .select('id, name, type, org_id')
      .eq('id', teamMemberId)
      .eq('type', 'agent')
      .single();

    if (!targetMember) {
      return ApiErrors.notFound('Agent not found');
    }

    // 같은 org인지 확인
    if (targetMember.org_id !== me.org_id) {
      return ApiErrors.forbidden('Cannot issue API key for agent in different org');
    }

    // API Key 생성
    const { apiKey, keyPrefix, keyHash } = generateApiKey();

    // DB에 저장
    const { data: apiKeyRow, error: insertError } = await supabase
      .from('agent_api_keys')
      .insert({
        team_member_id: teamMemberId,
        key_prefix: keyPrefix,
        key_hash: keyHash,
      })
      .select('id, key_prefix, created_at')
      .single();

    if (insertError || !apiKeyRow) {
      throw insertError || new Error('Failed to create API key');
    }

    // 평문 API Key는 1회만 반환
    return apiSuccess({
      id: apiKeyRow.id,
      key_prefix: apiKeyRow.key_prefix,
      created_at: apiKeyRow.created_at,
      api_key: apiKey, // ⚠️ 평문 키 (1회만 표시)
    }, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/**
 * GET /api/agents/[id]/api-key
 * 에이전트의 API Key 목록 조회
 *
 * Admin만 가능
 */
export async function GET(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id: teamMemberId } = await params;
      const repo = await createAgentApiKeyRepository();
      return apiSuccess(await repo.list(teamMemberId));
    } catch (err: unknown) { return handleApiError(err); }
  }
  try {
    const { id: teamMemberId } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    // Admin 권한 확인
    const { data: myMember } = await supabase
      .from('team_members')
      .select('role, org_id')
      .eq('id', me.id)
      .single();

    if (!myMember || !['owner', 'admin'].includes(myMember.role)) {
      return ApiErrors.forbidden('Admin only');
    }

    // API Key 목록 조회
    const { data: keys, error } = await supabase
      .from('agent_api_keys')
      .select('id, team_member_id, key_prefix, created_at, revoked_at, last_used_at')
      .eq('team_member_id', teamMemberId);

    if (error) throw error;

    return apiSuccess(keys ?? []);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
