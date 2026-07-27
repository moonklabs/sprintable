import type { INotificationRepository, Notification, CreateNotificationInput, NotificationListFilters } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class ApiNotificationRepository implements INotificationRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    return fastapiCall<Notification>('POST', '/api/v2/notifications', this.accessToken, { body: input });
  }

  async list(filters: NotificationListFilters): Promise<Notification[]> {
    return fastapiCall<Notification[]>('GET', '/api/v2/notifications', this.accessToken, { query: { user_id: filters.user_id, is_read: filters.is_read != null ? String(filters.is_read) : undefined, limit: filters.limit } });
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
