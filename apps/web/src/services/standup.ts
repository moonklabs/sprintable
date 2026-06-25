
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

/**
 * b47f9b05: ee standup GET이 Supabase-direct라 raw plan_story_ids만 내려 FE가 active-sprint scoped
 * stories fallback→백로그(sprint 밖) 탈락. plan_story_ids를 stories org-scope 조회로 resolve해
 * plan_stories(BE #1731 enrich 동형)로 채워 내린다. cross-board(타 프로젝트 백로그) 노출 보장.
 */
export interface PlanStorySummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  project_id: string;
  sprint_id: string | null;
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
  constructor(private readonly db: any) {}

  async getEntries(projectId: string, date: string) {
    const { data, error } = await this.db
      .from('standup_entries')
      .select('*')
      .eq('project_id', projectId)
      .eq('date', date)
      .order('created_at');
    if (error) throw error;
    const entries = (data ?? []) as Array<Record<string, unknown>>;
    const map = await this.resolvePlanStories(entries);
    return entries.map((e) => this.attachPlanStories(e, map));
  }

  async getEntryForUser(projectId: string, authorId: string, date: string) {
    const { data, error } = await this.db
      .from('standup_entries')
      .select('*')
      .eq('project_id', projectId)
      .eq('author_id', authorId)
      .eq('date', date)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return data;
    const map = await this.resolvePlanStories([data]);
    return this.attachPlanStories(data, map);
  }

  /** plan_story_ids → stories org-scope 조회(cross-board)로 PlanStorySummary 맵. admin client에도 org_id 가드. */
  private async resolvePlanStories(
    entries: Array<Record<string, unknown>>,
  ): Promise<Map<string, PlanStorySummary>> {
    const map = new Map<string, PlanStorySummary>();
    const ids = [...new Set(entries.flatMap((e) => (e.plan_story_ids as string[] | null) ?? []))];
    if (ids.length === 0) return map;
    const orgId = (entries.find((e) => e.org_id)?.org_id as string | undefined) ?? null;
    // ⭐ 불변식(디디): org_id 스코프 ONLY + deleted_at is null. sprint/project/board/status 필터 금지
    // — 좁히면 백로그(sprint 밖·타 보드) 다시 탈락(BE _entries_with_plan_stories 동형).
    let query = this.db
      .from('stories')
      .select('id, title, status, priority, project_id, sprint_id')
      .in('id', ids)
      .is('deleted_at', null);
    if (orgId) query = query.eq('org_id', orgId);
    const { data, error } = await query;
    if (error) throw error;
    for (const s of (data ?? []) as Array<Record<string, unknown>>) {
      map.set(s.id as string, {
        id: s.id as string,
        title: s.title as string,
        status: s.status as string,
        priority: s.priority as string,
        project_id: s.project_id as string,
        sprint_id: (s.sprint_id as string | null) ?? null,
      });
    }
    return map;
  }

  private attachPlanStories<T extends Record<string, unknown>>(
    entry: T,
    map: Map<string, PlanStorySummary>,
  ): T & { plan_stories: PlanStorySummary[] } {
    const ids = (entry.plan_story_ids as string[] | null) ?? [];
    return {
      ...entry,
      plan_stories: ids
        .map((id) => map.get(id))
        .filter((s): s is PlanStorySummary => Boolean(s)),
    };
  }

  async save(input: SaveStandupInput) {
    const { data, error } = await this.db
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
      const { data: settings } = await this.db
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

    const { data: members } = await this.db
      .from('team_members')
      .select('id, name')
      .eq('project_id', projectId)
      .eq('is_active', true);
    const { data: entries } = await this.db
      .from('standup_entries')
      .select('author_id')
      .eq('project_id', projectId)
      .eq('date', date);
    const submitted = new Set((entries ?? []).map((e) => e.author_id as string));
    const missing = (members ?? []).filter((m) => !submitted.has(m.id as string));
    return { submitted_count: submitted.size, missing: missing.map((m) => ({ id: m.id, name: m.name })) };
  }

  async getHistory(projectId: string, limit = 50) {
    const { data, error } = await this.db
      .from('standup_entries')
      .select('author_id, date, done, plan, blockers, plan_story_ids, org_id')
      .eq('project_id', projectId)
      .order('date', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const entries = (data ?? []) as Array<Record<string, unknown>>;
    const map = await this.resolvePlanStories(entries);
    return entries.map((e) => this.attachPlanStories(e, map));
  }
}

export class StandupFeedbackService {
  constructor(private readonly db: any) {}

  async listByDate(projectId: string, date: string): Promise<StandupFeedbackRecord[]> {
    const { data: entries, error: entriesError } = await this.db
      .from('standup_entries')
      .select('id')
      .eq('project_id', projectId)
      .eq('date', date);

    if (entriesError) throw entriesError;
    if (!entries || entries.length === 0) return [];

    const entryIds = entries.map((entry) => entry.id);
    const { data, error } = await this.db
      .from('standup_feedback')
      .select('*')
      .eq('project_id', projectId)
      .in('standup_entry_id', entryIds)
      .order('created_at');

    if (error) throw error;
    return (data ?? []) as StandupFeedbackRecord[];
  }

  async create(input: CreateStandupFeedbackInput): Promise<StandupFeedbackRecord> {
    const { data: entry, error: entryError } = await this.db
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

    const { data, error } = await this.db
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

    const { data: existing, error: existingError } = await this.db
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

    const { data, error } = await this.db
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
    const { data: existing, error: existingError } = await this.db
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

    const { error } = await this.db
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
