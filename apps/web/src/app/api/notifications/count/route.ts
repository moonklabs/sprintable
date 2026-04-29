import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createNotificationRepository } from '@/lib/storage/factory';

/** GET — 안읽음 뱃지용 COUNT만 반환 (full list 조회 없음) */
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const repo = await createNotificationRepository();
      const all = await repo.list({ user_id: me.id, is_read: false, limit: 200 });
      const memoUnreadCount = all.filter((n) => n.type?.startsWith('memo')).length;
      const inboxUnreadCount = all.length;
      return apiSuccess({ memoUnreadCount, inboxUnreadCount });
    }

    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const [memoResult, totalResult] = await Promise.all([
      dbClient
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', me.id)
        .eq('is_read', false)
        .like('type', 'memo%'),
      dbClient
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', me.id)
        .eq('is_read', false),
    ]);

    return apiSuccess({
      memoUnreadCount: memoResult.count ?? 0,
      inboxUnreadCount: totalResult.count ?? 0,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
