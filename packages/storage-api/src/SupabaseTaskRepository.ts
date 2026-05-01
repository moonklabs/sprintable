import type { ITaskRepository, Task, CreateTaskInput, UpdateTaskInput, TaskListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseTaskRepository implements ITaskRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateTaskInput): Promise<Task> {
    return fastapiCall<Task>('POST', '/api/v2/tasks', this.accessToken, { body: input });
  }

  async list(filters: TaskListFilters): Promise<Task[]> {
    return fastapiCall<Task[]>('GET', '/api/v2/tasks', this.accessToken, {
      query: { story_id: filters.story_id, assignee_id: filters.assignee_id, status: filters.status },
    });
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Task> {
    return fastapiCall<Task>('GET', `/api/v2/tasks/${id}`, this.accessToken);
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    return fastapiCall<Task>('PATCH', `/api/v2/tasks/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/tasks/${id}`, this.accessToken);
  }
}
