import type { SupabaseClient } from '@supabase/supabase-js';
import type { IStoryRepository, CreateStoryInput, UpdateStoryInput, BulkUpdateItem, StoryListFilters } from '@sprintable/core-storage';
import { SupabaseStoryRepository } from '@sprintable/storage-supabase';
import { NotFoundError, ForbiddenError } from './sprint';
import { requireOrgAdmin } from '@/lib/admin-check';

export type { CreateStoryInput, UpdateStoryInput, BulkUpdateItem };

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
  private readonly repo: IStoryRepository;
  private readonly supabase: SupabaseClient | null;

  constructor(repo: IStoryRepository, supabase?: SupabaseClient) {
    this.repo = repo;
    this.supabase = supabase ?? null;
  }

  static fromSupabase(supabase: SupabaseClient): StoryService {
    return new StoryService(new SupabaseStoryRepository(supabase), supabase);
  }

  async create(input: CreateStoryInput) {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');

    if (this.supabase) {
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

    return this.repo.create(input);
  }

  async list(filters: StoryListFilters) {
    return this.repo.list(filters);
  }

  async backlog(projectId: string) {
    return this.repo.backlog(projectId);
  }

  async getById(id: string) {
    try {
      return await this.repo.getById(id);
    } catch (err) {
      if (err instanceof Error && err.name === 'NotFoundError') throw new NotFoundError('Story not found');
      if (err instanceof Error && (err as { code?: string }).code === 'PGRST116') throw new NotFoundError('Story not found');
      throw err;
    }
  }

  async getByIdWithDetails(id: string) {
    return this.repo.getByIdWithDetails(id);
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
      // done → in-review는 admin만 (OSS: single user = always admin)
      if (currentStatus === 'done' && this.supabase) {
        try {
          await requireOrgAdmin(this.supabase, existing.org_id as string);
        } catch {
          throw new ForbiddenError('Admin permission required to reopen done stories');
        }
      }
    }

    return this.repo.update(id, sanitized as UpdateStoryInput);
  }

  async delete(id: string) {
    const story = await this.getById(id);
    if (this.supabase) {
      // done 상태 스토리 DELETE도 admin 권한 필요 (SID:357)
      await requireOrgAdmin(this.supabase, story.org_id as string);
      const { error: childError } = await this.supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('story_id', id);
      if (childError) throw new Error(`Failed to soft-delete tasks: ${childError.message}`);
    }
    await this.repo.delete(id);
  }

  async bulkUpdate(items: BulkUpdateItem[]) {
    return this.repo.bulkUpdate(items);
  }

  async addComment(input: { story_id: string; content: string; created_by: string }) {
    if (!input.content?.trim()) throw new Error('content is required');
    return this.repo.addComment({ ...input, content: input.content.trim() });
  }

  async getComments(storyId: string, options?: { limit?: number; cursor?: string }) {
    return this.repo.getComments(storyId, options);
  }

  async getActivities(storyId: string, options?: { limit?: number; cursor?: string }) {
    return this.repo.getActivities(storyId, options);
  }
}
