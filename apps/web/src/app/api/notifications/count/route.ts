import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createNotificationRepository } from '@/lib/storage/factory';

/** GET — 안읽음 뱃지용 COUNT만 반환 (full list 조회 없음) */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const repo = await createNotificationRepository();
    const all = await repo.list({ user_id: me.id, is_read: false, limit: 200 });
    const memoUnreadCount = all.filter((n) => n.type?.startsWith('memo')).length;
    const inboxUnreadCount = all.length;
    return apiSuccess({ memoUnreadCount, inboxUnreadCount });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
