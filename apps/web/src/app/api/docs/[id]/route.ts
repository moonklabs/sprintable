import { parseBody, updateDocSchema } from '@sprintable/shared';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';
import { requireRole, EDIT_ROLES, ADMIN_ROLES } from '@/lib/role-guard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
const ossMode = isOssMode();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbClient: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const parsed = await parseBody(request, updateDocSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository();
    const service = new DocsService(repo);

    if (!ossMode && dbClient) {
      const existing = await repo.getById(id);
      const docType = (existing as unknown as { doc_type?: string }).doc_type ?? 'page';
      if (docType === 'sprint_report') return apiError('FORBIDDEN', 'sprint_report documents are read-only', 403);
      if (docType === 'policy') {
        const denied = await requireRole(dbClient as SupabaseClient, existing.org_id, EDIT_ROLES, 'Admin or PO access required to edit policy documents');
        if (denied) return denied;
      }
    }

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
    const repo = await createDocRepository();
    const service = new DocsService(repo);
    return apiSuccess(await service.getDocTimestamp(id));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const repo = await createDocRepository();

    if (!ossMode && dbClient) {
      const existing = await repo.getById(id);
      const docType = (existing as unknown as { doc_type?: string }).doc_type ?? 'page';
      if (docType === 'sprint_report') return apiError('FORBIDDEN', 'sprint_report documents cannot be deleted', 403);
      if (docType === 'policy') {
        const denied = await requireRole(dbClient as SupabaseClient, existing.org_id, ADMIN_ROLES, 'Admin access required to delete policy documents');
        if (denied) return denied;
      }
    }

    const service = new DocsService(repo);
    await service.deleteDoc(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
