import { z } from 'zod';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { AgentSessionLifecycleError, AgentSessionLifecycleService } from '@/services/agent-session-lifecycle';
import { resumeSessionCandidates } from '@/services/agent-session-resume';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  status: z.enum(['active', 'idle', 'suspended', 'terminated']),
  reason: z.string().trim().min(1).max(400).optional(),
});

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { id } = await params;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const service = new AgentSessionLifecycleService(supabase as never);
    const result = await service.transitionSession({
      sessionId: id,
      orgId: me.org_id,
      projectId: me.project_id,
      actorId: me.id,
      status: parsed.data.status,
      reason: parsed.data.reason ?? null,
    });

    if (result.resumptions.length > 0) {
      await resumeSessionCandidates((await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) as never, result.resumptions);
    }

    return apiSuccess(result);
  } catch (error) {
    if (error instanceof AgentSessionLifecycleError) {
      return apiError(error.code, error.message, error.status);
    }
    return handleApiError(error);
  }
}
