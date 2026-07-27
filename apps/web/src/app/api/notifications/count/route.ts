import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createNotificationRepository } from '@/lib/storage/factory';

/** GET — 안읽음 뱃지용 COUNT만 반환 (full list 조회 없음)
 *
 * story #2194 — 예전엔 repo.list({ limit: 200 }).length로 뱃지 수를 냈다. BE가 이미
 * 진짜 unbounded SQL COUNT 엔드포인트(countUnread → /api/v2/notifications/count →
 * select(func.count()))를 제공하므로, list+length로 재구현하지 않고 그걸 그대로 쓴다.
 * list+length 방식은 200건 넘는 계정에서 실제 unread 수와 무관하게 항상 200을 반환하는
 * 결함이 있었다(뱃지가 "200건부터 거짓말"하는 자리).
 */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const repo = await createNotificationRepository();
    const inboxUnreadCount = await repo.countUnread(me.id);
    return apiSuccess({ inboxUnreadCount });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
