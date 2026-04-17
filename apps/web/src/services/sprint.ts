import type { SupabaseClient } from '@supabase/supabase-js';
import { requireOrgAdmin } from '@/lib/admin-check';

export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}

export class ForbiddenError extends Error {
  constructor(message: string) { super(message); this.name = 'ForbiddenError'; }
}

export interface CreateSprintInput {
  project_id: string;
  org_id: string;
  title: string;
  start_date: string;
  end_date: string;
  team_size?: number;
}

export interface UpdateSprintInput {
  title?: string;
  start_date?: string;
  end_date?: string;
  team_size?: number;
}

export class SprintService {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateSprintInput) {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.start_date) throw new Error('start_date is required');
    if (!input.end_date) throw new Error('end_date is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');

    const { data, error } = await this.supabase
      .from('sprints')
      .insert({
        project_id: input.project_id,
        org_id: input.org_id,
        title: input.title.trim(),
        start_date: input.start_date,
        end_date: input.end_date,
        team_size: input.team_size ?? null,
        status: 'planning',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async list(filters: { project_id?: string; status?: string }) {
    let query = this.supabase.from('sprints').select('*').order('created_at', { ascending: false });

    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.status) query = query.eq('status', filters.status);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const { data, error } = await this.supabase
      .from('sprints')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') throw new NotFoundError('Sprint not found');
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async update(id: string, input: UpdateSprintInput) {
    // allowlist: status, velocity, org_id, project_id 변경 차단
    const ALLOWED_FIELDS: (keyof UpdateSprintInput)[] = ['title', 'start_date', 'end_date', 'team_size'];
    const sanitized: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in input) sanitized[key] = input[key];
    }

    if (Object.keys(sanitized).length === 0) {
      throw new Error('No valid fields to update');
    }

    // 존재 여부 확인
    await this.getById(id);

    const { data, error } = await this.supabase
      .from('sprints')
      .update(sanitized)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') throw new NotFoundError('Sprint not found');
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async delete(id: string) {
    const sprint = await this.getById(id);
    await requireOrgAdmin(this.supabase, sprint.org_id as string);

    // 스토리 할당된 스프린트 삭제 불가
    const { data: stories } = await this.supabase
      .from('stories')
      .select('id')
      .eq('sprint_id', id)
      .limit(1);

    if (stories && stories.length > 0) {
      throw new Error('Cannot delete sprint with assigned stories');
    }

    const { error } = await this.supabase.from('sprints').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }

  async activate(id: string) {
    const sprint = await this.getById(id);
    if (sprint.status !== 'planning') {
      throw new Error(`Cannot activate sprint with status: ${sprint.status}`);
    }

    const { data, error } = await this.supabase
      .from('sprints')
      .update({ status: 'active' })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async getBurndown(id: string) {
    const sprint = await this.getById(id);
    const { data: stories, error } = await this.supabase
      .from('stories')
      .select('story_points, status, updated_at')
      .eq('sprint_id', id);
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
    const { data: members, error: membersError } = await this.supabase
      .from('team_members')
      .select('id')
      .eq('project_id', sprint.project_id as string)
      .eq('is_active', true);
    if (membersError) throw membersError;
    const { data: project } = await this.supabase
      .from('projects')
      .select('org_id')
      .eq('id', sprint.project_id as string)
      .single();
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
    const { data: stories, error: storiesError } = await this.supabase
      .from('stories')
      .select('status, story_points, assignee_id')
      .eq('sprint_id', id);
    if (storiesError) throw storiesError;
    const { data: members } = await this.supabase
      .from('team_members')
      .select('id, name')
      .eq('project_id', sprint.project_id as string)
      .eq('is_active', true);
    const { data: standups } = await this.supabase
      .from('standup_entries')
      .select('author_id')
      .eq('project_id', sprint.project_id as string)
      .eq('date', date);
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
    if (sprint.status !== 'active') {
      throw new Error(`Cannot close sprint with status: ${sprint.status}`);
    }

    // velocity 자동 계산: 완료된 스토리의 story_points 합
    const { data: doneStories } = await this.supabase
      .from('stories')
      .select('story_points')
      .eq('sprint_id', id)
      .eq('status', 'done');

    const velocity = (doneStories ?? []).reduce(
      (sum, s) => sum + (s.story_points ?? 0),
      0,
    );

    const { data, error } = await this.supabase
      .from('sprints')
      .update({ status: 'closed', velocity })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }
}
