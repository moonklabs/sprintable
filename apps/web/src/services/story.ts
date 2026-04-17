import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFoundError, ForbiddenError } from './sprint';
import { requireOrgAdmin } from '@/lib/admin-check';

export interface CreateStoryInput {
  project_id: string;
  org_id: string;
  title: string;
  epic_id?: string | null;
  sprint_id?: string | null;
  assignee_id?: string | null;
  status?: string;
  priority?: string;
  story_points?: number | null;
  description?: string | null;
  meeting_id?: string | null;
}

export interface UpdateStoryInput {
  title?: string;
  status?: string;
  priority?: string;
  story_points?: number | null;
  description?: string | null;
  epic_id?: string | null;
  sprint_id?: string | null;
  assignee_id?: string | null;
}

export interface BulkUpdateItem {
  id: string;
  status?: string;
  sprint_id?: string | null;
  assignee_id?: string | null;
}

/** 유효한 상태 전이 맵 (SID:357) */
const VALID_TRANSITIONS: Record<string, string[]> = {
  'backlog': ['ready-for-dev'],
  'ready-for-dev': ['in-progress', 'backlog'],
  'in-progress': ['in-review', 'ready-for-dev'],
  'in-review': ['done', 'in-progress'],
  'done': ['in-review'], // admin만
};

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class StoryService {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateStoryInput) {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');

    const { data, error } = await this.supabase
      .from('stories')
      .insert({
        project_id: input.project_id,
        org_id: input.org_id,
        title: input.title.trim(),
        epic_id: input.epic_id ?? null,
        sprint_id: input.sprint_id ?? null,
        assignee_id: input.assignee_id ?? null,
        status: input.status ?? 'backlog',
        priority: input.priority ?? 'medium',
        story_points: input.story_points ?? null,
        description: input.description ?? null,
        meeting_id: input.meeting_id ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }

    // 알림은 DB trigger(notify_story_assignee)가 자동 처리
    return data;
  }

  async list(filters: {
    sprint_id?: string;
    epic_id?: string;
    assignee_id?: string;
    status?: string;
    project_id?: string;
    q?: string;
    unassigned?: boolean;
    limit?: number;
    cursor?: string | null;
  }) {
    let query = this.supabase.from('stories').select('*').order('created_at', { ascending: false });

    if (filters.sprint_id) query = query.eq('sprint_id', filters.sprint_id);
    if (filters.epic_id) query = query.eq('epic_id', filters.epic_id);
    if (filters.assignee_id) query = query.eq('assignee_id', filters.assignee_id);
    if (filters.unassigned) query = query.is('assignee_id', null);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.q) query = query.ilike('title', `%${filters.q}%`);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async backlog(projectId: string) {
    const { data, error } = await this.supabase
      .from('stories')
      .select('*')
      .eq('project_id', projectId)
      .is('sprint_id', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const { data, error } = await this.supabase
      .from('stories')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') throw new NotFoundError('Story not found');
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async getByIdWithDetails(id: string) {
    const story = await this.getById(id);

    const { data: tasks } = await this.supabase
      .from('tasks')
      .select('*')
      .eq('story_id', id)
      .order('created_at');

    // NOTE: story comments 스키마가 아직 없으므로 tasks만 포함
    // story comments는 별도 스키마/AC 확정 후 추가 예정
    return { ...story, tasks: tasks ?? [] };
  }

  async update(id: string, input: UpdateStoryInput) {
    const ALLOWED_FIELDS: (keyof UpdateStoryInput)[] = [
      'title', 'status', 'priority', 'story_points', 'description',
      'epic_id', 'sprint_id', 'assignee_id',
    ];
    const sanitized: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in input) sanitized[key] = input[key];
    }
    if (Object.keys(sanitized).length === 0) throw new Error('No valid fields to update');

    const existing = await this.getById(id);

    // 상태 전이 검증 (SID:357)
    if (input.status && input.status !== existing.status) {
      const currentStatus = existing.status as string;
      const validNext = VALID_TRANSITIONS[currentStatus];
      if (!validNext || !validNext.includes(input.status)) {
        throw new InvalidTransitionError(currentStatus, input.status);
      }
      // done → in-review는 admin만
      if (currentStatus === 'done') {
        try {
          await requireOrgAdmin(this.supabase, existing.org_id as string);
        } catch {
          throw new ForbiddenError('Admin permission required to reopen done stories');
        }
      }
    }

    const { data, error } = await this.supabase
      .from('stories')
      .update(sanitized)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') throw new NotFoundError('Story not found');
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }

    // 알림은 DB trigger(notify_story_assignee)가 자동 처리
    return data;
  }

  async delete(id: string) {
    const story = await this.getById(id);
    // done 상태 스토리 DELETE도 admin 권한 필요 (SID:357)
    await requireOrgAdmin(this.supabase, story.org_id as string);

    // FK ON DELETE CASCADE가 소속 tasks 자동 삭제
    // 연관 tasks도 soft delete (soft delete이므로 FK CASCADE 미발동)
    const { error: childError } = await this.supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('story_id', id);
    if (childError) throw new Error(`Failed to soft-delete tasks: ${childError.message}`);

    const { error } = await this.supabase.from('stories').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
  }

  async bulkUpdate(items: BulkUpdateItem[]) {
    const results = [];
    for (const item of items) {
      const { id, ...updates } = item;
      const result = await this.update(id, updates);
      results.push(result);
    }
    return results;
  }

  // ============================================================
  // Comments
  // ============================================================
  async addComment(input: { story_id: string; content: string; created_by: string }) {
    if (!input.content?.trim()) throw new Error('content is required');

    // Get story to extract org_id and project_id
    const story = await this.getById(input.story_id);

    const { data, error } = await this.supabase
      .from('story_comments')
      .insert({
        story_id: input.story_id,
        org_id: story.org_id,
        project_id: story.project_id,
        content: input.content.trim(),
        created_by: input.created_by,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }

    return data;
  }

  async getComments(storyId: string, options?: { limit?: number; cursor?: string }) {
    let query = this.supabase
      .from('story_comments')
      .select('*')
      .eq('story_id', storyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (options?.cursor) {
      query = query.lt('created_at', options.cursor);
    }

    if (options?.limit) {
      query = query.limit(options.limit + 1);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data ?? [];
  }

  // ============================================================
  // Activities
  // ============================================================
  async getActivities(storyId: string, options?: { limit?: number; cursor?: string }) {
    let query = this.supabase
      .from('story_activities')
      .select('*')
      .eq('story_id', storyId)
      .order('created_at', { ascending: false });

    if (options?.cursor) {
      query = query.lt('created_at', options.cursor);
    }

    if (options?.limit) {
      query = query.limit(options.limit + 1);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data ?? [];
  }

  // 알림은 DB trigger(notify_story_assignee)가 SECURITY DEFINER로 자동 처리
  // RLS 우회하여 호출 주체(admin/member)와 무관하게 notifications INSERT 보장
}
