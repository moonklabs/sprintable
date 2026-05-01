import type { INotificationRepository, Notification, CreateNotificationInput, NotificationListFilters } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseNotificationRepository implements INotificationRepository {
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
}
