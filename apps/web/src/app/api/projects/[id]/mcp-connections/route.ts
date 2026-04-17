import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import {
  createMcpConnectionReviewRequest,
  listProjectMcpConnectionSummaries,
} from '@/services/project-mcp';

type RouteParams = { params: Promise<{ id: string }> };

const reviewRequestSchema = z.object({
  server_name: z.string().trim().min(1).max(120),
  server_url: z.string().trim().url(),
  notes: z.string().trim().max(2000).optional(),
});

async function requireAdminContext(projectId: string) {
  const supabase = await createSupabaseServerClient();
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

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await requireAdminContext(id);
    if ('error' in ctx) return ctx.error;

    const origin = new URL(request.url).origin;
    const admin = createSupabaseAdminClient();
    const connections = await listProjectMcpConnectionSummaries(admin as never, {
      orgId: ctx.me.org_id,
      projectId: id,
      origin,
      actorId: ctx.me.id,
    });

    return apiSuccess({
      project_id: id,
      connections,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await requireAdminContext(id);
    if ('error' in ctx) return ctx.error;

    const parsed = reviewRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const admin = createSupabaseAdminClient();
    const created = await createMcpConnectionReviewRequest(admin as never, {
      orgId: ctx.me.org_id,
      projectId: id,
      actorId: ctx.me.id,
      serverName: parsed.data.server_name,
      serverUrl: parsed.data.server_url,
      notes: parsed.data.notes,
    });

    return apiSuccess(created, undefined, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
