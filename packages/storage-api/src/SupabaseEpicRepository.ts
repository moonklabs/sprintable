import type { IEpicRepository, Epic, CreateEpicInput, UpdateEpicInput, EpicListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseEpicRepository implements IEpicRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateEpicInput): Promise<Epic> {
    return fastapiCall<Epic>('POST', '/api/v2/epics', this.accessToken, { body: input, orgId: input.org_id });
  }

  async list(filters: EpicListFilters): Promise<Epic[]> {
    // 569f5316: limit/cursor/order_by를 BE에 위임해 1000+ silent-truncation을 근절.
    // (이전엔 project_id만 전달 → BE 1000 cap에서 조용히 잘림.) over-fetch(+1)는 라우트가 책임.
    return fastapiCall<Epic[]>('GET', '/api/v2/epics', this.accessToken, {
      query: {
        project_id: filters.project_id,
        cursor: filters.cursor,
        limit: filters.limit,
        order_by: filters.order_by,
      },
    });
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
