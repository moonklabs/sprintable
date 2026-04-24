import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { z } from 'zod/v4';

type RouteParams = { params: Promise<{ id: string }> };

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional().nullable(),
});

async function resolveOrgRole(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, orgId: string, userId: string) {
  const { data } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.role as string | undefined;
}

// GET /api/projects/:id
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    const client = isOssMode() ? supabase : supabase;

    const { data: project, error } = await client
      .from('projects')
      .select('id, name, description, org_id, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!project) return ApiErrors.notFound('Project not found');

    return apiSuccess(project);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH /api/projects/:id — owner/admin only
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { data: project } = await supabase
      .from('projects')
      .select('org_id')
      .eq('id', id)
      .maybeSingle();

    if (!project) return ApiErrors.notFound('Project not found');

    const role = await resolveOrgRole(supabase, project.org_id as string, user.id);
    if (!role || !['owner', 'admin'].includes(role)) {
      return ApiErrors.forbidden('Admin access required');
    }

    const body = await request.json() as unknown;
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const update = parsed.data;

    if (!update.name && update.description === undefined) {
      return apiError('BAD_REQUEST', 'At least one field required', 400);
    }

    const { data: updated, error } = await supabase
      .from('projects')
      .update({ ...(update.name ? { name: update.name } : {}), ...(update.description !== undefined ? { description: update.description } : {}) })
      .eq('id', id)
      .select('id, name, description, org_id, created_at, updated_at')
      .single();

    if (error) throw error;
    return apiSuccess(updated);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
