import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode, createAgentApiKeyRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string; keyId: string }> };

/**
 * DELETE /api/agents/[id]/api-key/[keyId]
 * API Key revoke (취소)
 *
 * Admin만 가능
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { keyId } = await params;
      const repo = await createAgentApiKeyRepository();
      await repo.revoke(keyId);
      return apiSuccess({ message: 'API key revoked' });
    } catch (err: unknown) { return handleApiError(err); }
  }
  try {
    const { keyId } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    // Admin 권한 확인
    const { data: myMember } = await supabase
      .from('team_members')
      .select('role, org_id')
      .eq('id', me.id)
      .single();

    if (!myMember || myMember.role !== 'admin') {
      return ApiErrors.forbidden('Admin only');
    }

    // API Key 조회 (org 확인용)
    const { data: apiKeyRow } = await supabase
      .from('agent_api_keys')
      .select('id, team_member_id, team_members(org_id)')
      .eq('id', keyId)
      .single();

    if (!apiKeyRow) {
      return ApiErrors.notFound('API key not found');
    }

    const teamMember = Array.isArray(apiKeyRow.team_members)
      ? apiKeyRow.team_members[0]
      : apiKeyRow.team_members;

    // 같은 org인지 확인
    if ((teamMember as { org_id: string } | null)?.org_id !== me.org_id) {
      return ApiErrors.forbidden('Cannot revoke API key from different org');
    }

    // Revoke (revoked_at 설정)
    const { error: updateError } = await supabase
      .from('agent_api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId);

    if (updateError) throw updateError;

    return apiSuccess({ message: 'API key revoked' });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
