
import type { SupabaseClient } from '@/types/supabase';
import type { IStoryRepository, CreateStoryInput, UpdateStoryInput, BulkUpdateItem, StoryListFilters } from '@sprintable/core-storage';
import { ApiStoryRepository } from '@sprintable/storage-api';
import { NotFoundError, ForbiddenError } from './sprint';
import { requireOrgAdmin, isOrgAdmin } from '@/lib/admin-check';
import { VALID_STORY_TRANSITIONS } from '@sprintable/shared';

export type { CreateStoryInput, UpdateStoryInput, BulkUpdateItem };

const VALID_TRANSITIONS = VALID_STORY_TRANSITIONS;

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class StoryService {
  private readonly repo: IStoryRepository;
  private readonly db: SupabaseClient | null;
  private readonly isAdminContext: boolean;

  constructor(repo: IStoryRepository, db?: SupabaseClient, options?: { isAdminContext?: boolean }) {
    this.repo = repo;
    this.db = db ?? null;
    this.isAdminContext = options?.isAdminContext ?? false;
  }

  static fromDb(db: SupabaseClient): StoryService {
    return new StoryService(new ApiStoryRepository(), db);
  }

  async create(input: CreateStoryInput) {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');

    if (this.db) {
      const { data, error } = await this.db
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
      'title', 'status', 'priority', 'story_points', 'description', 'acceptance_criteria',
      'epic_id', 'sprint_id', 'assignee_id', 'position',
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
      const targetStatus = input.status;

      // admin/owner 또는 agent context는 어떤 상태에서든 backlog로 역전이 허용 (AC1)
      // isAdminContext: agent API key 경유 시 service_role client는 auth.getUser()가 null이므로 플래그로 우회
      const adminReverseToBacklog =
        targetStatus === 'backlog' &&
        (this.isAdminContext || (!!this.db && await isOrgAdmin(this.db, existing.org_id as string)));

      if (!adminReverseToBacklog) {
        const validNext = VALID_TRANSITIONS[currentStatus];
        if (!validNext || !validNext.includes(targetStatus)) {
          // 비관리자의 역방향 전이 시도 (AC2)
          if (targetStatus === 'backlog') {
            throw new ForbiddenError('Admin permission required to move story back to backlog');
          }
          throw new InvalidTransitionError(currentStatus, targetStatus);
        }
      }

      // done → in-review는 admin만 (OSS: single user = always admin)
      if (currentStatus === 'done' && targetStatus !== 'backlog' && this.db) {
        try {
          await requireOrgAdmin(this.db, existing.org_id as string);
        } catch {
          throw new ForbiddenError('Admin permission required to reopen done stories');
        }
      }
    }

    return this.repo.update(id, sanitized as UpdateStoryInput);
  }

  async delete(id: string) {
    const story = await this.getById(id);
    if (this.db) {
      // done 상태 스토리 DELETE도 admin 권한 필요 (SID:357)
      await requireOrgAdmin(this.db, story.org_id as string);
      const { error: childError } = await this.db.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('story_id', id);
      if (childError) throw new Error(`Failed to soft-delete tasks: ${childError.message}`);
    }
    await this.repo.delete(id);
  }

  async bulkUpdate(items: BulkUpdateItem[]) {
    // status 변경 item에 대해 전이 검증 (bulk 경로 우회 방지)
    const statusItems = items.filter((item) => item.status !== undefined);
    if (statusItems.length > 0) {
      await Promise.all(
        statusItems.map(async (item) => {
          const existing = await this.getById(item.id);
          const currentStatus = existing.status as string;
          const targetStatus = item.status as string;
          if (targetStatus === currentStatus) return;

          const adminReverseToBacklog =
            targetStatus === 'backlog' &&
            (this.isAdminContext || (!!this.db && await isOrgAdmin(this.db, existing.org_id as string)));

          if (!adminReverseToBacklog) {
            const validNext = VALID_TRANSITIONS[currentStatus];
            if (!validNext || !validNext.includes(targetStatus)) {
              if (targetStatus === 'backlog') {
                throw new ForbiddenError('Admin permission required to move story back to backlog');
              }
              throw new InvalidTransitionError(currentStatus, targetStatus);
            }
          }

          // done → in-review는 admin만 (단건 update()와 동일)
          if (currentStatus === 'done' && targetStatus !== 'backlog' && this.db) {
            try {
              await requireOrgAdmin(this.db, existing.org_id as string);
            } catch {
              throw new ForbiddenError('Admin permission required to reopen done stories');
            }
          }
        }),
      );
    }
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

  async logActivity(input: { story_id: string; org_id: string; actor_id: string; action_type: string; old_value?: string | null; new_value?: string | null }): Promise<void> {
    await this.repo.addActivity(input);
  }
}
