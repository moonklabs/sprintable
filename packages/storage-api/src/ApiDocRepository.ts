import type { IDocRepository, Doc, DocSummary, CreateDocInput, UpdateDocInput, DocListFilters, DocPageResult, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

interface RawDocPageResponse {
  data: DocSummary[];
  meta: { has_more: boolean; next_cursor: string | null };
}

export class ApiDocRepository implements IDocRepository {
  constructor(private readonly accessToken: string = '') {}

  // story #2191(#2231 규약 A) — BE가 {data, meta:{has_more, next_cursor}}로 응답한다(#2540).
  // 커서는 (sort_order, id) 복합 불투명 문자열("5:uuid") — 그대로 왕복만 시킨다(파싱 금지).
  async list(filters: DocListFilters): Promise<DocPageResult> {
    const res = await fastapiCall<RawDocPageResponse>('GET', '/api/v2/docs', this.accessToken, {
      query: {
        project_id: filters.project_id,
        limit: filters.limit,
        cursor: filters.cursor ?? undefined,
        tags: filters.tags?.join(','),
        q: filters.q,
      },
    });
    return { items: res.data, hasMore: res.meta.has_more, nextCursor: res.meta.next_cursor };
  }

  // story #2191: 단건 slug 조회도 BE에서 이제 {data,meta} 봉투로 온다(has_more는 구조적으로
  // 항상 false — 단건 lookup이라 페이지네이션 대상이 아님, #2540 주석 참고).
  async getBySlug(projectId: string, slug: string): Promise<Doc> {
    const res = await fastapiCall<RawDocPageResponse>('GET', '/api/v2/docs', this.accessToken, {
      query: { project_id: projectId, slug },
    });
    const first = res.data[0];
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
