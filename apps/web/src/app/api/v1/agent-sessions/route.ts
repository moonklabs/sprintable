import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { AgentSessionLifecycleService } from '@/services/agent-session-lifecycle';
import { isOssMode } from '@/lib/storage/factory';

const querySchema = z.object({
  agentId: z.string().uuid().optional(),
  status: z.enum(['active', 'idle', 'suspended', 'terminated']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const service = new AgentSessionLifecycleService(supabase as never);
    const sessions = await service.listSessions({
      orgId: me.org_id,
      projectId: me.project_id,
      agentId: parsed.data.agentId,
      status: parsed.data.status,
      limit: parsed.data.limit,
    });

    return apiSuccess({ sessions });
  } catch (error) {
    return handleApiError(error);
  }
}
