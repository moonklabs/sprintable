import { createSupabaseServerClient } from '@/lib/supabase/server';
import { apiError, ApiErrors, apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { AgentRoutingRuleService } from '@/services/agent-routing-rule';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { isOssMode } from '@/lib/storage/factory';
import { getAuthContext } from '@/lib/auth-helpers';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function GET(request: Request) {
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
      supabaseForService = supabase;
    }

    const gateResponse = await requireAgentOrchestration(supabaseForService, me.org_id);
    if (gateResponse) return gateResponse;

    const service = new AgentRoutingRuleService(supabaseForService);
    const versions = await service.listVersions({ orgId: me.org_id, projectId: me.project_id });
    return apiSuccess(versions);
  } catch (error) {
    return handleApiError(error);
  }
}
