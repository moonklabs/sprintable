import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createProjectRepository } from '@/lib/storage/factory';
import { z } from 'zod/v4';

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

    const repo = await createProjectRepository();
    const project = await repo.getById(id);
    if (!project) return ApiErrors.notFound('Project not found');

    return apiSuccess(project);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH /api/projects/:id
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    let body: unknown;
    try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'At least one field required', 400); }
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const update = parsed.data;

    if (!update.name && update.description === undefined) {
      return apiError('BAD_REQUEST', 'At least one field required', 400);
    }

    const repo = await createProjectRepository();
    const existing = await repo.getById(id);
    if (!existing) return ApiErrors.notFound('Project not found');

    const updated = await repo.update(id, {
      ...(update.name ? { name: update.name } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
    });

    return apiSuccess(updated);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// DELETE /api/projects/:id — soft delete
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const orgId = me.org_id;

    const repo = await createProjectRepository();
    const existing = await repo.getById(id);
    if (!existing) return ApiErrors.notFound('Project not found');

    await repo.delete(id, orgId);
    return apiSuccess({ id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
