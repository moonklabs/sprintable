import type { ISprintRepository, Sprint, CreateSprintInput, UpdateSprintInput, SprintListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseSprintRepository implements ISprintRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateSprintInput): Promise<Sprint> {
    return fastapiCall<Sprint>('POST', '/api/v2/sprints', this.accessToken, { body: input, orgId: input.org_id });
  }

  async list(filters: SprintListFilters): Promise<Sprint[]> {
    return fastapiCall<Sprint[]>('GET', '/api/v2/sprints', this.accessToken, { query: { project_id: filters.project_id, status: filters.status } });
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Sprint> {
    return fastapiCall<Sprint>('GET', `/api/v2/sprints/${id}`, this.accessToken);
  }

  async update(id: string, input: UpdateSprintInput): Promise<Sprint> {
    return fastapiCall<Sprint>('PATCH', `/api/v2/sprints/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/sprints/${id}`, this.accessToken);
  }
}
