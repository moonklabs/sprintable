import { createSupabaseServerClient } from '@/lib/supabase/server';
import { apiError, ApiErrors, apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { AgentRoutingRuleService } from '@/services/agent-routing-rule';
import { requireOrgAdmin } from '@/lib/admin-check';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { isOssMode } from '@/lib/storage/factory';
import { getAuthContext } from '@/lib/auth-helpers';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    let supabaseForService: SupabaseClient;
    if (me.type === 'agent') {
      const { createSupabaseAdminClient } = await import('@/lib/supabase/admin');
      supabaseForService = createSupabaseAdminClient();
    } else {
      await requireOrgAdmin(supabase, me.org_id);
      supabaseForService = supabase;
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
