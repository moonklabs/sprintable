import type { INotificationRepository, Notification, CreateNotificationInput, NotificationListFilters, NotificationListResult } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

interface RawNotificationListResponse {
  data: Notification[];
  meta: { has_more: boolean; next_cursor: string | null };
}

export class ApiNotificationRepository implements INotificationRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    return fastapiCall<Notification>('POST', '/api/v2/notifications', this.accessToken, { body: input });
  }

  // story #2195(#2231 규약 A) — BE가 {data, meta:{has_more, next_cursor}}로 응답한다(#2538).
  // cursor는 BE 쿼리 파라미터명 `before`로 매핑한다(FE 공통 필드명은 cursor로 유지 — 다른
  // 저장소들과 인터페이스 일관성).
  async list(filters: NotificationListFilters): Promise<NotificationListResult> {
    const res = await fastapiCall<RawNotificationListResponse>('GET', '/api/v2/notifications', this.accessToken, {
      query: {
        user_id: filters.user_id,
        is_read: filters.is_read != null ? String(filters.is_read) : undefined,
        limit: filters.limit,
        before: filters.cursor ?? undefined,
      },
    });
    return { items: res.data, hasMore: res.meta.has_more, nextCursor: res.meta.next_cursor };
  }

  async markRead(id: string, _userId: string): Promise<Notification> {
    return fastapiCall<Notification>('PATCH', `/api/v2/notifications/${id}/read`, this.accessToken);
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await fastapiCall<{ count?: number }>('PATCH', '/api/v2/notifications/mark-all-read', this.accessToken, { query: { user_id: userId } });
    return result?.count ?? 0;
  }

  // story #2194 — BE(/api/v2/notifications/count)가 이미 select(func.count())로 진짜
  // unbounded 카운트를 낸다. 여기서 list(limit:200) 등으로 재구현하면 200건 초과 계정에서
  // 항상 200에 고정되는 결함이 재발한다. 이 BE 라우트는 user_id를 쿼리로 안 받고 auth
  // context에서만 파생한다(notifications.py count_unread) — 그래서 인자로 받는 userId는
  // 인터페이스 시그니처 일관성을 위해 남기되 쿼리로 넘기지 않는다.
  async countUnread(_userId: string): Promise<number> {
    const result = await fastapiCall<{ count?: number }>('GET', '/api/v2/notifications/count', this.accessToken);
    return result?.count ?? 0;
  }
}
