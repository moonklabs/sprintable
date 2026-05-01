import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireOrgAdmin } from '@/lib/admin-check';
import { AgentPersonaService } from '@/services/agent-persona';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { isOssMode } from '@/lib/storage/factory';

const createPersonaSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  system_prompt: z.string().optional(),
  style_prompt: z.string().nullable().optional(),
  model: z.string().trim().nullable().optional(),
  base_persona_id: z.string().min(1).nullable().optional(),
  tool_allowlist: z.array(z.string().min(1)).optional(),
  is_default: z.boolean().optional(),
});

export async function GET(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');
    if (!agentId) return ApiErrors.badRequest('agent_id required');

    const service = new AgentPersonaService(supabase);
    const personas = await service.listPersonas({
      orgId: me.org_id,
      projectId: me.project_id,
      agentId,
      includeBuiltin: searchParams.get('include_builtin') === 'true',
    });

    return apiSuccess(personas);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const parsed = createPersonaSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }

    const { agent_id: agentId, ...body } = parsed.data;

    const service = new AgentPersonaService(supabase);
    const persona = await service.createPersona({
      orgId: me.org_id,
      projectId: me.project_id,
      agentId,
      actorId: me.id,
      ...body,
    });

    return apiSuccess(persona, undefined, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
