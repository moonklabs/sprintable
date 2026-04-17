import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  INotificationRepository,
  Notification,
  CreateNotificationInput,
  NotificationListFilters,
} from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseNotificationRepository implements INotificationRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    const { data, error } = await this.supabase
      .from('notifications')
      .insert({
        org_id: input.org_id,
        user_id: input.user_id,
        type: input.type ?? 'info',
        title: input.title,
        body: input.body ?? null,
        reference_type: input.reference_type ?? null,
        reference_id: input.reference_id ?? null,
        is_read: false,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as Notification;
  }

  async list(filters: NotificationListFilters): Promise<Notification[]> {
    let query = this.supabase
      .from('notifications')
      .select('*')
      .eq('user_id', filters.user_id)
      .order('created_at', { ascending: false });
    if (filters.is_read != null) query = query.eq('is_read', filters.is_read);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Notification[];
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    const { data, error } = await this.supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Notification;
  }

  async markAllRead(userId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false)
      .select('id');
    if (error) throw mapSupabaseError(error);
    return (data ?? []).length;
  }
}
