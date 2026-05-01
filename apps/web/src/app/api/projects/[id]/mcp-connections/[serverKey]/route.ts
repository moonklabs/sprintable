import { z } from 'zod';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { AgentDeploymentLifecycleService } from '@/services/agent-deployment-lifecycle';
import {
  deleteProjectMcpConnection,
  upsertProjectMcpConnection,
} from '@/services/project-mcp';
import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string; serverKey: string }> };

const upsertConnectionSchema = z.object({
  secret: z.string().trim().min(1),
  label: z.string().trim().max(120).optional(),
});

async function requireAdminContext(projectId: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ApiErrors.unauthorized() as Response };

  const me = await getMyTeamMember(supabase, user);
  if (!me) return { error: ApiErrors.forbidden() as Response };
  await requireOrgAdmin(supabase, me.org_id);

  if (me.project_id !== projectId) {
    return { error: ApiErrors.forbidden('Current project admin context required') as Response };
  }

  return { supabase, me };
}

export async function PUT(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'MCP connection management is not supported in OSS mode.', 501);
  try {
    const { id, serverKey } = await params;
    const ctx = await requireAdminContext(id);
    if ('error' in ctx) return ctx.error;

    const parsed = upsertConnectionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const admin = (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient());
    const connection = await upsertProjectMcpConnection(admin as never, {
      orgId: ctx.me.org_id,
      projectId: id,
      actorId: ctx.me.id,
      serverKey,
      secret: parsed.data.secret,
      label: parsed.data.label,
    });

    return apiSuccess(connection);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'MCP connection management is not supported in OSS mode.', 501);
  try {
    const { id, serverKey } = await params;
    const ctx = await requireAdminContext(id);
    if ('error' in ctx) return ctx.error;

    const admin = (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient());
    await deleteProjectMcpConnection(admin as never, {
      projectId: id,
      serverKey,
    });

    const { data: deployments, error: deploymentError } = await ctx.supabase
      .from('agent_deployments')
      .select('id, status')
      .eq('org_id', ctx.me.org_id)
      .eq('project_id', id)
      .in('status', ['DEPLOYING', 'ACTIVE']);

    if (deploymentError) throw deploymentError;

    const lifecycle = new AgentDeploymentLifecycleService(ctx.supabase as never);
    for (const deployment of deployments ?? []) {
      await lifecycle.transitionDeployment({
        orgId: ctx.me.org_id,
        projectId: id,
        actorId: ctx.me.id,
        deploymentId: deployment.id as string,
        status: 'SUSPENDED',
      });
    }

    return apiSuccess({
      deleted: true,
      server_key: serverKey,
      suspended_deployments: (deployments ?? []).length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
