import type { IDocRepository, Doc, DocSummary, CreateDocInput, UpdateDocInput, DocListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseDocRepository implements IDocRepository {
  constructor(private readonly accessToken: string = '') {}

  async list(filters: DocListFilters): Promise<DocSummary[]> {
    return fastapiCall<DocSummary[]>('GET', '/api/v2/docs', this.accessToken, {
      query: {
        project_id: filters.project_id,
        limit: filters.limit,
        cursor: filters.cursor ?? undefined,
        tags: filters.tags?.join(','),
      },
    });
  }

  async getTree(projectId: string): Promise<DocSummary[]> {
    return fastapiCall<DocSummary[]>('GET', '/api/v2/docs', this.accessToken, { query: { project_id: projectId } });
  }

  async getBySlug(projectId: string, slug: string): Promise<Doc> {
    const summaries = await fastapiCall<DocSummary[]>('GET', '/api/v2/docs', this.accessToken, {
      query: { project_id: projectId, slug },
    });
    const first = summaries[0];
    if (!first) throw new Error(`Doc not found: ${slug}`);
    return fastapiCall<Doc>('GET', `/api/v2/docs/${first.id}`, this.accessToken);
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Doc> {
    return fastapiCall<Doc>('GET', `/api/v2/docs/${id}`, this.accessToken);
  }

  async create(input: CreateDocInput): Promise<Doc> {
    return fastapiCall<Doc>('POST', '/api/v2/docs', this.accessToken, { body: input, orgId: input.org_id });
  }

  async update(id: string, input: UpdateDocInput): Promise<Doc> {
    return fastapiCall<Doc>('PATCH', `/api/v2/docs/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/docs/${id}`, this.accessToken);
  }
}
