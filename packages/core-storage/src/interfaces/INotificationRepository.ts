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

// story #2195(#2231 규약 A) — BE가 has_more/next_cursor를 body meta로 직접 계산해 낸다
// (limit+1 오버페치는 BE 내부에서 이미 끝남 — FE가 buildCursorPageMeta로 재추론하지 않는다).
export interface NotificationListResult {
  items: Notification[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface INotificationRepository {
  create(input: CreateNotificationInput): Promise<Notification>;
  list(filters: NotificationListFilters): Promise<NotificationListResult>;
  markRead(id: string, userId: string): Promise<Notification>;
  markAllRead(userId: string): Promise<number>;
  // story #2194 — list(limit:200).length는 200건 넘는 계정에서 실제 unread 수를 거짓으로
  // 200에 고정시킨다. BE에 이미 진짜 unbounded SQL COUNT 엔드포인트(/api/v2/notifications/count)가
  // 있으므로 뱃지는 반드시 이 메서드로 받아야 한다 — list+length로 대체하지 말 것.
  countUnread(userId: string): Promise<number>;
}
