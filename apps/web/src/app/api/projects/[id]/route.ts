import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, ADMIN_ROLES } from '@/lib/role-guard';
import { z } from 'zod/v4';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional().nullable(),
});

// GET /api/projects/:id
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();

    const { data: project, error } = await supabase
      .from('projects')
      .select('id, name, description, org_id, created_at, updated_at')
      .eq('id', id)
      .eq('org_id', me.org_id)
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
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { data: project } = await supabase
      .from('projects')
      .select('org_id')
      .eq('id', id)
      .maybeSingle();

    if (!project) return ApiErrors.notFound('Project not found');

    if (!isOssMode() && me.type !== 'agent') {
      const denied = await requireRole(supabase, project.org_id as string, ADMIN_ROLES, 'Admin access required');
      if (denied) return denied;
    }

    let body: unknown;
    try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'At least one field required', 400); }
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

// DELETE /api/projects/:id — soft delete (owner/admin only)
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { data: project } = await supabase
      .from('projects')
      .select('org_id')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();

    if (!project) return ApiErrors.notFound('Project not found');

    if (!isOssMode() && me.type !== 'agent') {
      const denied = await requireRole(supabase, project.org_id as string, ADMIN_ROLES, 'Admin access required');
      if (denied) return denied;
    }

    const { error } = await supabase
      .from('projects')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;
    return apiSuccess({ id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
