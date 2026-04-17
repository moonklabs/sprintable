import type { PaginationOptions } from '../types';

export interface Notification {
  id: string;
  org_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  is_read: boolean;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface CreateNotificationInput {
  org_id: string;
  user_id: string;
  type?: string;
  title: string;
  body?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
}

export interface NotificationListFilters extends PaginationOptions {
  user_id: string;
  is_read?: boolean;
}

export interface INotificationRepository {
  create(input: CreateNotificationInput): Promise<Notification>;
  list(filters: NotificationListFilters): Promise<Notification[]>;
  markRead(id: string, userId: string): Promise<Notification>;
  markAllRead(userId: string): Promise<number>;
}
