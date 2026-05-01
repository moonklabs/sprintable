import type { IMemoRepository, Memo, CreateMemoInput, UpdateMemoInput, MemoReply, MemoListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseMemoRepository implements IMemoRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateMemoInput): Promise<Memo> {
    return fastapiCall<Memo>('POST', '/api/v2/memos', this.accessToken, { body: input, orgId: input.org_id });
  }

  async list(filters: MemoListFilters): Promise<Memo[]> {
    return fastapiCall<Memo[]>('GET', '/api/v2/memos', this.accessToken, { query: { project_id: filters.project_id, assigned_to: filters.assigned_to, created_by: filters.created_by, status: filters.status, q: filters.q } });
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Memo> {
    return fastapiCall<Memo>('GET', `/api/v2/memos/${id}`, this.accessToken);
  }

  async update(id: string, input: UpdateMemoInput): Promise<Memo> {
    return fastapiCall<Memo>('PATCH', `/api/v2/memos/${id}`, this.accessToken, { body: input });
  }

  async resolve(id: string, resolvedBy: string): Promise<Memo> {
    return fastapiCall<Memo>('POST', `/api/v2/memos/${id}/resolve`, this.accessToken, { query: { resolved_by: resolvedBy } });
  }

  async archive(id: string, archivedAt: string | null): Promise<Memo> {
    return fastapiCall<Memo>('POST', `/api/v2/memos/${id}/archive`, this.accessToken, { body: { archived_at: archivedAt } });
  }

  async addReply(input: { memo_id: string; content: string; created_by: string; review_type?: string }): Promise<MemoReply> {
    return fastapiCall<MemoReply>('POST', `/api/v2/memos/${input.memo_id}/replies`, this.accessToken, { body: { content: input.content, created_by: input.created_by, review_type: input.review_type ?? 'comment' } });
  }

  async getReplies(memoId: string): Promise<MemoReply[]> {
    const memo = await fastapiCall<{ replies?: MemoReply[] }>('GET', `/api/v2/memos/${memoId}`, this.accessToken);
    return memo.replies ?? [];
  }
}
