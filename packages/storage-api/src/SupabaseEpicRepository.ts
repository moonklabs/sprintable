import type { IEpicRepository, Epic, CreateEpicInput, UpdateEpicInput, EpicListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseEpicRepository implements IEpicRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateEpicInput): Promise<Epic> {
    return fastapiCall<Epic>('POST', '/api/v2/epics', this.accessToken, { body: input, orgId: input.org_id });
  }

  async list(filters: EpicListFilters): Promise<Epic[]> {
    return fastapiCall<Epic[]>('GET', '/api/v2/epics', this.accessToken, { query: { project_id: filters.project_id } });
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Epic> {
    return fastapiCall<Epic>('GET', `/api/v2/epics/${id}`, this.accessToken);
  }

  async getByIdWithStories(id: string, scope?: RepositoryScopeContext): Promise<Epic & { stories: unknown[] }> {
    const epic = await this.getById(id, scope);
    const stories = await fastapiCall<unknown[]>('GET', '/api/v2/stories', this.accessToken, { query: { epic_id: id } });
    return { ...epic, stories };
  }

  async update(id: string, input: UpdateEpicInput): Promise<Epic> {
    return fastapiCall<Epic>('PATCH', `/api/v2/epics/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/epics/${id}`, this.accessToken);
  }
}
