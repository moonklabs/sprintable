import { parseBody, updateDocSchema } from '@sprintable/shared';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const parsed = await parseBody(request, updateDocSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient);

    const doc = await service.updateDoc(id, {
      ...body,
      created_by: me.id,
      expected_updated_at: body.expected_updated_at,
      force_overwrite: body.force_overwrite,
    });
    return apiSuccess(doc);
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    if (e.code === 'CONFLICT') return apiError('CONFLICT', e.message, 409);
    if (e.code === 'NOT_FOUND') return apiError('NOT_FOUND', e.message, 404);
    if (e.code === 'BAD_REQUEST') return apiError('BAD_REQUEST', e.message, 400);
    return handleApiError(err);
  }
}

/** Lightweight timestamp check for remote-change polling */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient);
    return apiSuccess(await service.getDocTimestamp(id));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const repo = await createDocRepository(dbClient);

    const service = new DocsService(repo, dbClient);
    await service.deleteDoc(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
