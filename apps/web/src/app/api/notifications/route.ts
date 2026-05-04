import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { attachNotificationHrefs } from '@/services/notification-navigation';
import { parseBody, updateNotificationSchema } from '@sprintable/shared';
import { createNotificationRepository } from '@/lib/storage/factory';

/** GET — 알림 목록 (안읽음 우선, 최신순) */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const typeFilter = searchParams.get('type');
    const unreadOnly = searchParams.get('unread') === 'true';

    const repo = await createNotificationRepository();
    const notifications = await repo.list({
      user_id: me.id,
      is_read: unreadOnly ? false : undefined,
      limit: 50,
    });
    const filtered = typeFilter ? notifications.filter((n) => n.type === typeFilter) : notifications;
    const withHrefs = await attachNotificationHrefs(undefined, filtered);
    const unreadCount = filtered.filter((n) => !n.is_read).length;
    return apiSuccess(withHrefs, { unreadCount });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** PATCH — 읽음 처리 (단일 또는 전체) */
export async function PATCH(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const parsed = await parseBody(request, updateNotificationSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const repo = await createNotificationRepository();
    if (body.markAllRead) {
      await repo.markAllRead(me.id);
      return apiSuccess({ ok: true });
    }
    if (body.id) {
      await repo.markRead(body.id, me.id);
      return apiSuccess({ ok: true });
    }
    return ApiErrors.badRequest('id or markAllRead required');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
