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
    // story #2195(#2231 규약 A) — 하드코딩 limit=50 + 커서 없음으로 51번째부터 조용히
    // 잘리던 자리. BE(#2538)가 before 커서 + has_more/next_cursor를 지원한다.
    const cursor = searchParams.get('cursor');

    const repo = await createNotificationRepository();
    const { items, hasMore, nextCursor } = await repo.list({
      user_id: me.id,
      is_read: unreadOnly ? false : undefined,
      limit: 50,
      cursor,
    });
    // ⛔type 필터는 서버 커서 페이지 이후 클라이언트 측 후처리다 — 이 필터를 쓰는 유일한
    // 호출자(now-face.tsx)는 페이지네이션 없이 단발 조회만 하므로 hasMore/nextCursor와
    // 어긋나지 않는다(#2195 스코프 확認). 페이지네이션 UI(inbox 기본 탭)는 typeFilter를
    // 안 쓴다.
    const filtered = typeFilter ? items.filter((n) => n.type === typeFilter) : items;
    const withHrefs = await attachNotificationHrefs(undefined, filtered);
    const unreadCount = filtered.filter((n) => !n.is_read).length;
    return apiSuccess(withHrefs, { unreadCount, hasMore, nextCursor });
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
