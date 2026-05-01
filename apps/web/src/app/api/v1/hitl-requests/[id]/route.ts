import { z } from 'zod';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { AgentHitlService, HitlConflictError } from '@/services/agent-hitl';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

const resolveHitlSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    comment: z.string().trim().min(1).max(2000).optional(),
  }),
  z.object({
    action: z.literal('reject'),
    comment: z.string().trim().min(1).max(2000),
  }),
]);

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

    const parsed = resolveHitlSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const service = new AgentHitlService(supabase as never);
    const result = await service.respond({
      requestId: id,
      actorId: me.id,
      orgId: me.org_id,
      projectId: me.project_id,
      action: parsed.data.action,
      comment: parsed.data.comment ?? null,
    });

    return apiSuccess(result);
  } catch (error) {
    if (error instanceof HitlConflictError) {
      return apiError('CONFLICT', error.message, 409);
    }
    return handleApiError(error);
  }
}
