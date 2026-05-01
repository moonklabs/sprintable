import type { SupabaseClient } from '@supabase/supabase-js';
import type { INotificationRepository, Notification, CreateNotificationInput, NotificationListFilters } from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { fastapiCall, mapSupabaseError } from './utils';

export class SupabaseNotificationRepository implements INotificationRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async create(input: CreateNotificationInput): Promise<Notification> {
    if (this.fastapi) return fastapiCall<Notification>('POST', '/api/v2/notifications', this.accessToken, { body: input });
    const { data, error } = await this.supabase.from('notifications').insert({ org_id: input.org_id, user_id: input.user_id, type: input.type ?? 'info', title: input.title, body: input.body ?? null, reference_type: input.reference_type ?? null, reference_id: input.reference_id ?? null, is_read: false }).select().single();
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw error; }
    return data as Notification;
  }

  async list(filters: NotificationListFilters): Promise<Notification[]> {
    if (this.fastapi) return fastapiCall<Notification[]>('GET', '/api/v2/notifications', this.accessToken, { query: { user_id: filters.user_id, is_read: filters.is_read != null ? String(filters.is_read) : undefined, limit: filters.limit } });
    let query = this.supabase.from('notifications').select('*').eq('user_id', filters.user_id).order('created_at', { ascending: false });
    if (filters.is_read != null) query = query.eq('is_read', filters.is_read);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Notification[];
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    if (this.fastapi) return fastapiCall<Notification>('PATCH', `/api/v2/notifications/${id}/read`, this.accessToken);
    const { data, error } = await this.supabase.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw mapSupabaseError(error);
    return data as Notification;
  }

  async markAllRead(userId: string): Promise<number> {
    if (this.fastapi) {
      const result = await fastapiCall<{ count?: number }>('PATCH', '/api/v2/notifications/mark-all-read', this.accessToken, { query: { user_id: userId } });
      return result?.count ?? 0;
    }
    const { data, error } = await this.supabase.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false).select('id');
    if (error) throw mapSupabaseError(error);
    return (data ?? []).length;
  }
}
