import type { IEpicRepository, CreateEpicInput, UpdateEpicInput, RepositoryScopeContext } from '@sprintable/core-storage';
export type { CreateEpicInput, UpdateEpicInput } from '@sprintable/core-storage';
import { validateStatusTransition } from '@/lib/epic-permissions';

export class EpicService {
  constructor(private readonly repository: IEpicRepository) {}

  async create(input: CreateEpicInput) {
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');
    return this.repository.create(input);
  }

  async list(filters: { project_id?: string; limit?: number; cursor?: string | null }) {
    return this.repository.list(filters);
  }

  async getById(id: string, scope?: RepositoryScopeContext) {
    return this.repository.getById(id, scope);
  }

  async getByIdWithStories(id: string, scope?: RepositoryScopeContext) {
    return this.repository.getByIdWithStories(id, scope);
  }

  async update(id: string, input: UpdateEpicInput, scope?: RepositoryScopeContext) {
    if (input.status) {
      const current = await this.repository.getById(id, scope);
      validateStatusTransition(current.status, input.status);
    }
    return this.repository.update(id, input);
  }

  async delete(id: string, orgId: string) {
    return this.repository.delete(id, orgId);
  }
}
