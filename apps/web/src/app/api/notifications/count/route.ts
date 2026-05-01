import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createNotificationRepository } from '@/lib/storage/factory';

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const repo = await createNotificationRepository();
      const all = await repo.list({ user_id: me.id, is_read: false, limit: 200 });
      const memoUnreadCount = all.filter((n) => n.type?.startsWith('memo')).length;
      const inboxUnreadCount = all.length;
      return apiSuccess({ memoUnreadCount, inboxUnreadCount });
    }

    return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
