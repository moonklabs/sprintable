import type { ITaskRepository, CreateTaskInput, UpdateTaskInput, TaskListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
export type { CreateTaskInput, UpdateTaskInput } from '@sprintable/core-storage';
export { NotFoundError, ForbiddenError } from '@sprintable/core-storage';

export class TaskService {
  constructor(private readonly repository: ITaskRepository) {}

  async create(input: CreateTaskInput) {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.story_id) throw new Error('story_id is required');
    return this.repository.create(input);
  }

  async list(filters: TaskListFilters) {
    return this.repository.list(filters);
  }

  // story #3718 — 진짜 총계(BE X-Total-Count). list(...).length는 안 쓴다(getStoryTaskCounts
  // 참고).
  async count(filters: Omit<TaskListFilters, 'limit' | 'cursor'>) {
    return this.repository.count(filters);
  }

  async getById(id: string, scope?: RepositoryScopeContext) {
    return this.repository.getById(id, scope);
  }

  async update(id: string, input: UpdateTaskInput) {
    return this.repository.update(id, input);
  }

  async delete(id: string, orgId: string) {
    return this.repository.delete(id, orgId);
  }
}
