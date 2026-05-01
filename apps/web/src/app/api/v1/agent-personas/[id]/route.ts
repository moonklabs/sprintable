import { z } from 'zod';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireOrgAdmin } from '@/lib/admin-check';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { AgentPersonaService } from '@/services/agent-persona';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

const updatePersonaSchema = z.object({
  name: z.string().trim().min(1).optional(),
  slug: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  system_prompt: z.string().optional(),
  style_prompt: z.string().nullable().optional(),
  model: z.string().trim().nullable().optional(),
  base_persona_id: z.string().min(1).nullable().optional(),
  tool_allowlist: z.array(z.string().min(1)).optional(),
  is_default: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { id } = await params;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const service = new AgentPersonaService(supabase);
    const persona = await service.getPersonaById(id, {
      orgId: me.org_id,
      projectId: me.project_id,
    });

    return apiSuccess(persona);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { id } = await params;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const parsed = updatePersonaSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }

    const service = new AgentPersonaService(supabase);
    const persona = await service.updatePersona(id, {
      orgId: me.org_id,
      projectId: me.project_id,
    }, {
      actorId: me.id,
      ...parsed.data,
    });

    return apiSuccess(persona);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { id } = await params;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const service = new AgentPersonaService(supabase);
    const result = await service.deletePersona(id, {
      orgId: me.org_id,
      projectId: me.project_id,
    }, me.id);

    return apiSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}
