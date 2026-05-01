import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createMemoRepository, isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

// PATCH /api/memos/:id/archive — archived_at 설정/해제 토글
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) return ApiErrors.notFound('Archive not supported in OSS mode');

    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const repo = await createMemoRepository();
    const memo = await repo.getById(id);

    const archivedAt = memo.archived_at ? null : new Date().toISOString();
    const updated = await repo.archive(id, archivedAt);
    return apiSuccess(updated);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
