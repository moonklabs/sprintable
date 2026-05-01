import type { IStoryRepository, Story, CreateStoryInput, UpdateStoryInput, BulkUpdateItem, StoryComment, StoryListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import type { PaginationOptions } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseStoryRepository implements IStoryRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateStoryInput): Promise<Story> {
    return fastapiCall<Story>('POST', '/api/v2/stories', this.accessToken, { body: input, orgId: input.org_id });
  }

  async list(filters: StoryListFilters): Promise<Story[]> {
    return fastapiCall<Story[]>('GET', '/api/v2/stories', this.accessToken, {
      query: { project_id: filters.project_id, epic_id: filters.epic_id, sprint_id: filters.sprint_id, assignee_id: filters.assignee_id, status: filters.status },
    });
  }

  async backlog(projectId: string): Promise<Story[]> {
    const all = await fastapiCall<Story[]>('GET', '/api/v2/stories', this.accessToken, { query: { project_id: projectId } });
    return all.filter((s) => !s.sprint_id && !s.deleted_at);
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Story> {
    return fastapiCall<Story>('GET', `/api/v2/stories/${id}`, this.accessToken);
  }

  async getByIdWithDetails(id: string, scope?: RepositoryScopeContext): Promise<Story & { tasks: unknown[] }> {
    const story = await this.getById(id, scope);
    const tasks = await fastapiCall<unknown[]>('GET', '/api/v2/tasks', this.accessToken, { query: { story_id: id } });
    return { ...story, tasks };
  }

  async update(id: string, input: UpdateStoryInput): Promise<Story> {
    return fastapiCall<Story>('PATCH', `/api/v2/stories/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/stories/${id}`, this.accessToken);
  }

  async bulkUpdate(items: BulkUpdateItem[]): Promise<Story[]> {
    return Promise.all(items.map(({ id, ...patch }) => this.update(id, patch)));
  }

  async addComment(input: { story_id: string; content: string; created_by: string }): Promise<StoryComment> {
    return fastapiCall<StoryComment>('POST', `/api/v2/stories/${input.story_id}/comments`, this.accessToken, { body: { content: input.content, created_by: input.created_by } });
  }

  async getComments(storyId: string, options?: PaginationOptions): Promise<StoryComment[]> {
    return fastapiCall<StoryComment[]>('GET', `/api/v2/stories/${storyId}/comments`, this.accessToken, {
      query: { cursor: options?.cursor, limit: options?.limit },
    });
  }

  async getActivities(storyId: string, options?: PaginationOptions): Promise<unknown[]> {
    return fastapiCall<unknown[]>('GET', `/api/v2/stories/${storyId}/activities`, this.accessToken, {
      query: { cursor: options?.cursor, limit: options?.limit },
    });
  }

  async addActivity(input: { story_id: string; org_id: string; actor_id: string; action_type: string; old_value?: string | null; new_value?: string | null }): Promise<void> {
    await fastapiCall<void>('POST', `/api/v2/stories/${input.story_id}/activities`, this.accessToken, { body: input });
  }
}
