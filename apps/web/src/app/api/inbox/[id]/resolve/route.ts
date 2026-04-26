import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createInboxItemRepository } from '@/lib/storage/factory';
import { parseBody, resolveInboxItemSchema } from '@sprintable/shared';
import { NotFoundError } from '@sprintable/core-storage';

/** POST /api/inbox/:id/resolve — 의사결정 처리 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return ApiErrors.badRequest('id required');

    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const ossMode = isOssMode();
    const dbClient: SupabaseClient | undefined = ossMode
      ? undefined
      : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);

    const parsed = await parseBody(request, resolveInboxItemSchema);
    if (!parsed.success) return parsed.response;

    const repo = await createInboxItemRepository(dbClient);
    try {
      const result = await repo.resolve(id, me.org_id, {
        resolved_by: me.id,
        resolved_option_id: parsed.data.choice,
        resolved_note: parsed.data.note ?? null,
      });
      return apiSuccess(result);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) return ApiErrors.notFound(err.message);
      // 이미 resolved/dismissed 상태(SQLite throws Error, Postgres throws 23514)
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('already')) return apiError('CONFLICT', msg, 409);
      if (msg.includes('Option id') || msg.includes('option_id')) return ApiErrors.badRequest(msg);
      throw err;
    }
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
