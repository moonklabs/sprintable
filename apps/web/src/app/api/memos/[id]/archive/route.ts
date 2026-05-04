import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createMemoRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

// PATCH /api/memos/:id/archive — archived_at 설정/해제 토글
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);


    const dbClient = undefined;
    const repo = await createMemoRepository();
    const memo = await repo.getById(id);

    const archivedAt = memo.archived_at ? null : new Date().toISOString();
    const updated = await repo.archive(id, archivedAt);
    return apiSuccess(updated);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
