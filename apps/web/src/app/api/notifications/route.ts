import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { attachNotificationHrefs } from '@/services/notification-navigation';
import { parseBody, updateNotificationSchema } from '@sprintable/shared';
import { isOssMode, createNotificationRepository } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

/** GET — 알림 목록 (안읽음 우선, 최신순) */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient: SupabaseClient | undefined = ossMode ? undefined : (me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase);

    const { searchParams } = new URL(request.url);
    const typeFilter = searchParams.get('type');
    const unreadOnly = searchParams.get('unread') === 'true';

    if (ossMode) {
      const repo = await createNotificationRepository();
      const notifications = await repo.list({
        user_id: me.id,
        is_read: unreadOnly ? false : undefined,
        limit: 50,
      });
      const unreadCount = notifications.filter((n) => !n.is_read).length;
      return apiSuccess(notifications, { unreadCount });
    }

    let query = dbClient!
      .from('notifications')
      .select('*')
      .eq('user_id', me.id)
      .order('is_read', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(50);

    if (typeFilter) query = query.eq('type', typeFilter);
    if (unreadOnly) query = query.eq('is_read', false);

    const { data, error } = await query;
    if (error) throw error;

    let countQuery = dbClient!
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', me.id)
      .eq('is_read', false);

    if (typeFilter) countQuery = countQuery.eq('type', typeFilter);

    const [countResult, notifications] = await Promise.all([
      countQuery,
      attachNotificationHrefs(dbClient!, data ?? []),
    ]);

    const { count } = countResult;
    return apiSuccess(notifications, { unreadCount: count ?? 0 });
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
    const ossMode = isOssMode();
    const dbClient: SupabaseClient | undefined = ossMode ? undefined : (me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase);

    const parsed = await parseBody(request, updateNotificationSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    if (ossMode) {
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
    }

    if (body.markAllRead) {
      let query = dbClient!
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', me.id)
        .eq('is_read', false);
      if (body.type) query = query.eq('type', body.type);
      const { error } = await query;
      if (error) throw error;
      return apiSuccess({ ok: true });
    }

    if (body.id) {
      const { error } = await dbClient!
        .from('notifications')
        .update({ is_read: body.is_read ?? true })
        .eq('id', body.id)
        .eq('user_id', me.id);
      if (error) throw error;
      return apiSuccess({ ok: true });
    }

    return ApiErrors.badRequest('id or markAllRead required');
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
