
import type { IStoryRepository, CreateStoryInput, UpdateStoryInput, BulkUpdateItem, StoryListFilters } from '@sprintable/core-storage';
import { ApiStoryRepository } from '@sprintable/storage-api';
import { NotFoundError, ForbiddenError } from './sprint';
import { requireOrgAdmin } from '@/lib/admin-check';

export type { CreateStoryInput, UpdateStoryInput, BulkUpdateItem };

// InvalidTransitionError 클래스는 보존(epic 전용 전이 변환 등 공유 컨슈머용). 단 story 전이에선 더는 throw 안 함.
export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class StoryService {
  private readonly repo: IStoryRepository;
  private readonly db: any | null;
  private readonly isAdminContext: boolean;

  constructor(repo: IStoryRepository, db?: any, options?: { isAdminContext?: boolean }) {
    this.repo = repo;
    this.db = db ?? null;
    this.isAdminContext = options?.isAdminContext ?? false;
  }

  static fromDb(db: any): StoryService {
    return new StoryService(new ApiStoryRepository(db), db);
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
      'attachments', 'epic_id', 'sprint_id', 'assignee_id', 'assignee_ids', 'position',
      'success_hypothesis', 'metric_definition', 'measure_after',
    ];
    const sanitized: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in input) sanitized[key] = input[key];
    }
    if (Object.keys(sanitized).length === 0) throw new Error('No valid fields to update');

    // 존재 검증(없으면 NotFoundError).
    await this.getById(id);

    // 정공법 A(c1cd484b): 상태 전이 하드블록 폐지 — 드로어 단건수정도 보드(/bulk)처럼 자유 이동.
    // 비정상 점프/ done reopen 모두 차단하지 않는다(선생님 지시). 위반 기록/가시화는 BE SSOT 책임.
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
    // 정공법 A(c1cd484b): 상태 전이 하드블록 폐지 — 보드 /bulk(FastAPI)와 동일 거동(자유 이동).
    // 비정상 점프/done reopen 차단 안 함. 위반 기록/가시화는 BE SSOT 책임.
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
