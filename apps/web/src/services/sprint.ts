import type { SupabaseClient } from '@supabase/supabase-js';
import type { ISprintRepository, CreateSprintInput, UpdateSprintInput } from '@sprintable/core-storage';
import { SupabaseSprintRepository } from '@sprintable/storage-supabase';
import { requireOrgAdmin } from '@/lib/admin-check';

export { CreateSprintInput, UpdateSprintInput };

export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}

export class ForbiddenError extends Error {
  constructor(message: string) { super(message); this.name = 'ForbiddenError'; }
}

export class SprintService {
  private readonly repo: ISprintRepository;
  private readonly supabase: SupabaseClient | null;

  constructor(repo: ISprintRepository, supabase?: SupabaseClient) {
    this.repo = repo;
    this.supabase = supabase ?? null;
  }

  static fromSupabase(supabase: SupabaseClient): SprintService {
    return new SprintService(new SupabaseSprintRepository(supabase), supabase);
  }

  async create(input: CreateSprintInput) {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.start_date) throw new Error('start_date is required');
    if (!input.end_date) throw new Error('end_date is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');
    return this.repo.create(input);
  }

  async list(filters: { project_id?: string; status?: string }) {
    return this.repo.list(filters);
  }

  async getById(id: string) {
    try {
      return await this.repo.getById(id);
    } catch (err) {
      if (err instanceof Error && (err.name === 'NotFoundError' || (err as { code?: string }).code === 'PGRST116')) {
        throw new NotFoundError('Sprint not found');
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateSprintInput) {
    const ALLOWED_FIELDS: (keyof UpdateSprintInput)[] = ['title', 'start_date', 'end_date', 'team_size'];
    const sanitized: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in input) sanitized[key] = input[key];
    }
    if (Object.keys(sanitized).length === 0) throw new Error('No valid fields to update');
    await this.getById(id);
    return this.repo.update(id, sanitized as UpdateSprintInput);
  }

  async delete(id: string) {
    const sprint = await this.getById(id);
    if (this.supabase) {
      await requireOrgAdmin(this.supabase, sprint.org_id as string);
      const { data: stories } = await this.supabase.from('stories').select('id').eq('sprint_id', id).limit(1);
      if (stories && stories.length > 0) throw new Error('Cannot delete sprint with assigned stories');
    }
    await this.repo.delete(id, sprint.org_id as string);
  }

  async activate(id: string) {
    const sprint = await this.getById(id);
    if (sprint.status !== 'planning') throw new Error(`Cannot activate sprint with status: ${sprint.status}`);
    return this.repo.update(id, { status: 'active' });
  }

  async getBurndown(id: string) {
    const sprint = await this.getById(id);
    if (!this.supabase) {
      return { sprint, total_points: 0, done_points: 0, remaining_points: 0, completion_pct: 0, stories_count: 0, done_count: 0 };
    }
    const { data: stories, error } = await this.supabase.from('stories').select('story_points, status, updated_at').eq('sprint_id', id);
    if (error) throw error;
    const totalPoints = (stories ?? []).reduce((sum, s) => sum + ((s.story_points as number) ?? 0), 0);
    const donePoints = (stories ?? []).filter((s) => s.status === 'done').reduce((sum, s) => sum + ((s.story_points as number) ?? 0), 0);
    return {
      sprint,
      total_points: totalPoints,
      done_points: donePoints,
      remaining_points: totalPoints - donePoints,
      completion_pct: totalPoints > 0 ? Math.round((donePoints / totalPoints) * 100) : 0,
      stories_count: stories?.length ?? 0,
      done_count: (stories ?? []).filter((s) => s.status === 'done').length,
    };
  }

  async kickoff(id: string, message?: string) {
    const sprint = await this.getById(id);
    if (!this.supabase) return { notified: 0 };

    const { data: members, error: membersError } = await this.supabase
      .from('team_members').select('id').eq('project_id', sprint.project_id as string).eq('is_active', true);
    if (membersError) throw membersError;
    const { data: project } = await this.supabase.from('projects').select('org_id').eq('id', sprint.project_id as string).single();
    const notifications = (members ?? []).map((member) => ({
      org_id: project?.org_id as string,
      user_id: member.id as string,
      type: 'info',
      title: `🚀 ${sprint.title as string} 킥오프!`,
      body: message ?? `${sprint.title as string}가 시작되었습니다.`,
      reference_type: 'sprint',
      reference_id: id,
    }));
    if (notifications.length) {
      const { error } = await this.supabase.from('notifications').insert(notifications);
      if (error) throw error;
    }
    return { notified: notifications.length };
  }

  async checkin(id: string, date: string) {
    const sprint = await this.getById(id);
    if (!this.supabase) {
      return { total_stories: 0, total_points: 0, done_points: 0, completion_pct: 0, missing_standups: [] };
    }
    const { data: stories, error: storiesError } = await this.supabase
      .from('stories').select('status, story_points, assignee_id').eq('sprint_id', id);
    if (storiesError) throw storiesError;
    const { data: members } = await this.supabase
      .from('team_members').select('id, name').eq('project_id', sprint.project_id as string).eq('is_active', true);
    const { data: standups } = await this.supabase
      .from('standup_entries').select('author_id').eq('project_id', sprint.project_id as string).eq('date', date);
    const standupAuthors = new Set((standups ?? []).map((s) => s.author_id as string));
    const missing = (members ?? []).filter((m) => !standupAuthors.has(m.id as string));
    const totalPts = (stories ?? []).reduce((sum, s) => sum + ((s.story_points as number) ?? 0), 0);
    const donePts = (stories ?? []).filter((s) => s.status === 'done').reduce((sum, s) => sum + ((s.story_points as number) ?? 0), 0);
    return {
      total_stories: stories?.length ?? 0,
      total_points: totalPts,
      done_points: donePts,
      completion_pct: totalPts > 0 ? Math.round((donePts / totalPts) * 100) : 0,
      missing_standups: missing.map((m) => ({ id: m.id, name: m.name })),
    };
  }

  async close(id: string) {
    const sprint = await this.getById(id);
    if (sprint.status !== 'active') throw new Error(`Cannot close sprint with status: ${sprint.status}`);

    let velocity = 0;
    if (this.supabase) {
      const { data: doneStories } = await this.supabase.from('stories').select('story_points').eq('sprint_id', id).eq('status', 'done');
      velocity = (doneStories ?? []).reduce((sum, s) => sum + (s.story_points ?? 0), 0);
    }

    return this.repo.update(id, { status: 'closed', velocity } as UpdateSprintInput);
  }
}
