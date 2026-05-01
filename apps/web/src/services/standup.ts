// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { ForbiddenError, NotFoundError } from './sprint';

export type StandupReviewType = 'comment' | 'approve' | 'request_changes';

export interface SaveStandupInput {
  project_id: string;
  org_id: string;
  sprint_id?: string | null;
  author_id: string;
  date: string;
  done: string | null;
  plan: string | null;
  blockers: string | null;
  plan_story_ids?: string[];
}

export interface CreateStandupFeedbackInput {
  project_id: string;
  org_id: string;
  standup_entry_id: string;
  feedback_by_id: string;
  review_type?: StandupReviewType;
  feedback_text: string;
}

export interface UpdateStandupFeedbackInput {
  review_type?: StandupReviewType;
  feedback_text?: string;
}

export interface StandupFeedbackRecord {
  id: string;
  org_id: string;
  project_id: string;
  sprint_id: string | null;
  standup_entry_id: string;
  feedback_by_id: string;
  review_type: StandupReviewType;
  feedback_text: string;
  created_at: string;
  updated_at: string;
}

export class StandupService {
  constructor(private readonly supabase: SupabaseClient) {}

  async getEntries(projectId: string, date: string) {
    const { data, error } = await this.supabase
      .from('standup_entries')
      .select('*')
      .eq('project_id', projectId)
      .eq('date', date)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  async getEntryForUser(projectId: string, authorId: string, date: string) {
    const { data, error } = await this.supabase
      .from('standup_entries')
      .select('*')
      .eq('project_id', projectId)
      .eq('author_id', authorId)
      .eq('date', date)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async save(input: SaveStandupInput) {
    const { data, error } = await this.supabase
      .from('standup_entries')
      .upsert({
        project_id: input.project_id,
        org_id: input.org_id,
        sprint_id: input.sprint_id ?? null,
        author_id: input.author_id,
        date: input.date,
        done: input.done,
        plan: input.plan,
        blockers: input.blockers,
        plan_story_ids: input.plan_story_ids ?? [],
      }, { onConflict: 'project_id,author_id,date' })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getMissing(projectId: string, date: string) {
    // deadline 조회: 오늘 날짜면 마감 전 여부 체크
    const today = new Date().toISOString().slice(0, 10);
    if (date === today) {
      const { data: settings } = await this.supabase
        .from('project_settings')
        .select('standup_deadline')
        .eq('project_id', projectId)
        .maybeSingle();
      const deadline = (settings?.standup_deadline as string | null) ?? '09:00';
      const [dh, dm] = deadline.split(':').map(Number);
      const now = new Date();
      const deadlineTime = new Date(now);
      deadlineTime.setHours(dh, dm, 0, 0);
      if (now < deadlineTime) {
        return { submitted_count: 0, missing: [], deadline_not_reached: true };
      }
    }

    const { data: members } = await this.supabase
      .from('team_members')
      .select('id, name')
      .eq('project_id', projectId)
      .eq('is_active', true);
    const { data: entries } = await this.supabase
      .from('standup_entries')
      .select('author_id')
      .eq('project_id', projectId)
      .eq('date', date);
    const submitted = new Set((entries ?? []).map((e) => e.author_id as string));
    const missing = (members ?? []).filter((m) => !submitted.has(m.id as string));
    return { submitted_count: submitted.size, missing: missing.map((m) => ({ id: m.id, name: m.name })) };
  }

  async getHistory(projectId: string, limit = 50) {
    const { data, error } = await this.supabase
      .from('standup_entries')
      .select('author_id, date, done, plan, blockers')
      .eq('project_id', projectId)
      .order('date', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }
}

export class StandupFeedbackService {
  constructor(private readonly supabase: SupabaseClient) {}

  async listByDate(projectId: string, date: string): Promise<StandupFeedbackRecord[]> {
    const { data: entries, error: entriesError } = await this.supabase
      .from('standup_entries')
      .select('id')
      .eq('project_id', projectId)
      .eq('date', date);

    if (entriesError) throw entriesError;
    if (!entries || entries.length === 0) return [];

    const entryIds = entries.map((entry) => entry.id);
    const { data, error } = await this.supabase
      .from('standup_feedback')
      .select('*')
      .eq('project_id', projectId)
      .in('standup_entry_id', entryIds)
      .order('created_at');

    if (error) throw error;
    return (data ?? []) as StandupFeedbackRecord[];
  }

  async create(input: CreateStandupFeedbackInput): Promise<StandupFeedbackRecord> {
    const { data: entry, error: entryError } = await this.supabase
      .from('standup_entries')
      .select('id, org_id, project_id, sprint_id')
      .eq('id', input.standup_entry_id)
      .single();

    if (entryError) {
      if (entryError.code === 'PGRST116') throw new NotFoundError('Standup entry not found');
      if (entryError.code === '42501') throw new ForbiddenError('Permission denied');
      throw entryError;
    }

    if (entry.project_id !== input.project_id || entry.org_id !== input.org_id) {
      throw new ForbiddenError('Permission denied');
    }

    const feedbackText = input.feedback_text.trim();
    if (!feedbackText) throw new Error('feedback_text is required');

    const { data, error } = await this.supabase
      .from('standup_feedback')
      .insert({
        org_id: entry.org_id,
        project_id: entry.project_id,
        sprint_id: entry.sprint_id ?? null,
        standup_entry_id: input.standup_entry_id,
        feedback_by_id: input.feedback_by_id,
        review_type: input.review_type ?? 'comment',
        feedback_text: feedbackText,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as StandupFeedbackRecord;
  }

  async update(id: string, input: UpdateStandupFeedbackInput, feedbackById: string): Promise<StandupFeedbackRecord> {
    const sanitized: Record<string, unknown> = {};
    if (input.review_type) sanitized.review_type = input.review_type;
    if (input.feedback_text !== undefined) {
      const feedbackText = input.feedback_text.trim();
      if (!feedbackText) throw new Error('feedback_text is required');
      sanitized.feedback_text = feedbackText;
    }
    if (Object.keys(sanitized).length === 0) throw new Error('No valid fields to update');

    const { data: existing, error: existingError } = await this.supabase
      .from('standup_feedback')
      .select('id, feedback_by_id')
      .eq('id', id)
      .single();

    if (existingError) {
      if (existingError.code === 'PGRST116') throw new NotFoundError('Standup feedback not found');
      if (existingError.code === '42501') throw new ForbiddenError('Permission denied');
      throw existingError;
    }

    if (!existing || existing.feedback_by_id !== feedbackById) {
      throw new ForbiddenError('Permission denied');
    }

    const { data, error } = await this.supabase
      .from('standup_feedback')
      .update(sanitized)
      .eq('id', id)
      .eq('feedback_by_id', feedbackById)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') throw new NotFoundError('Standup feedback not found');
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as StandupFeedbackRecord;
  }

  async delete(id: string, feedbackById: string): Promise<void> {
    const { data: existing, error: existingError } = await this.supabase
      .from('standup_feedback')
      .select('id, feedback_by_id')
      .eq('id', id)
      .single();

    if (existingError) {
      if (existingError.code === 'PGRST116') throw new NotFoundError('Standup feedback not found');
      if (existingError.code === '42501') throw new ForbiddenError('Permission denied');
      throw existingError;
    }

    if (!existing || existing.feedback_by_id !== feedbackById) {
      throw new ForbiddenError('Permission denied');
    }

    const { error } = await this.supabase
      .from('standup_feedback')
      .delete()
      .eq('id', id)
      .eq('feedback_by_id', feedbackById);

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }
}
