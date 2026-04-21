import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTeamMemberFromRequest } from '@/lib/auth-api-key';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiError, ApiErrors, apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { AgentRoutingRuleService } from '@/services/agent-routing-rule';
import { requireOrgAdmin } from '@/lib/admin-check';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { isOssMode } from '@/lib/storage/factory';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    let me: { id: string; org_id: string; project_id: string };
    let supabaseForService: Awaited<ReturnType<typeof createSupabaseServerClient>> | ReturnType<typeof createSupabaseAdminClient>;

    let apiKeyMe: Awaited<ReturnType<typeof getTeamMemberFromRequest>> = null;
    let adminClientRef: ReturnType<typeof createSupabaseAdminClient> | null = null;
    try {
      adminClientRef = createSupabaseAdminClient();
      apiKeyMe = await getTeamMemberFromRequest(adminClientRef, request);
    } catch { /* SUPABASE_SERVICE_ROLE_KEY 미설정 시 세션 fallback */ }

    if (apiKeyMe && adminClientRef) {
      me = apiKeyMe;
      supabaseForService = adminClientRef;
    } else {
      const supabase = await createSupabaseServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return ApiErrors.unauthorized();
      const sessionMe = await getMyTeamMember(supabase, user);
      if (!sessionMe) return ApiErrors.forbidden();
      me = sessionMe;
      supabaseForService = supabase;
      await requireOrgAdmin(supabase, me.org_id);
    }

    const gateResponse = await requireAgentOrchestration(supabaseForService, me.org_id);
    if (gateResponse) return gateResponse;

    const { id } = await params;
    if (!id) return ApiErrors.badRequest('id required');

    const service = new AgentRoutingRuleService(supabaseForService);
    const rules = await service.rollbackToVersion(id, { orgId: me.org_id, projectId: me.project_id }, me.id);
    return apiSuccess(rules);
  } catch (error) {
    return handleApiError(error);
  }
}
