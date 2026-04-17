import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireOrgAdmin } from '@/lib/admin-check';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { AgentPersonaService } from '@/services/agent-persona';

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
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
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
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
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
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
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
