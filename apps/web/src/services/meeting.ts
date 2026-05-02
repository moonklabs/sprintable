
import type { SupabaseClient } from '@/types/supabase';

export class MeetingService {
  constructor(private readonly db: SupabaseClient) {}

  async list(projectId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const { data, error, count } = await this.db
      .from('meetings')
      .select('id, title, meeting_type, date, duration_min, participants, ai_summary, created_at', { count: 'exact' })
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return { items: data ?? [], total: count ?? 0 };
  }

  async getById(id: string) {
    const { data, error } = await this.db
      .from('meetings')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (error) throw error;
    return data;
  }

  async create(input: {
    project_id: string;
    title: string;
    meeting_type?: string;
    date?: string;
    duration_min?: number;
    participants?: unknown[];
    raw_transcript?: string;
    ai_summary?: string;
    decisions?: unknown[];
    action_items?: unknown[];
    created_by?: string;
  }) {
    const { data, error } = await this.db
      .from('meetings')
      .insert(input)
      .select('id, title, meeting_type, date, duration_min, created_at')
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, input: {
    title?: string;
    meeting_type?: string;
    date?: string;
    duration_min?: number | null;
    participants?: unknown[];
    raw_transcript?: string | null;
    ai_summary?: string | null;
    decisions?: unknown[];
    action_items?: unknown[];
  }) {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) updates[k] = v;
    }

    const { data, error } = await this.db
      .from('meetings')
      .update(updates)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id, title, meeting_type, date, updated_at')
      .single();

    if (error) throw error;
    return data;
  }

  async delete(id: string) {
    const { error } = await this.db
      .from('meetings')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null);

    if (error) throw error;
  }
}
