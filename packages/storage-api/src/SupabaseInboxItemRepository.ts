import type { IInboxItemRepository, InboxItem, CreateInboxItemInput, InboxListFilters, ResolveInboxItemInput, DismissInboxItemInput, ReassignInboxItemInput, InboxItemCount } from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseInboxItemRepository implements IInboxItemRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateInboxItemInput): Promise<InboxItem> {
    return fastapiCall<InboxItem>('POST', '/api/v2/inbox', this.accessToken, { body: input });
  }

  async list(filters: InboxListFilters): Promise<InboxItem[]> {
    return fastapiCall<InboxItem[]>('GET', '/api/v2/inbox', this.accessToken, { query: { assignee_member_id: filters.assignee_member_id, kind: filters.kind, state: filters.state } });
  }

  async get(id: string, _orgId: string): Promise<InboxItem | null> {
    try { return await fastapiCall<InboxItem>('GET', `/api/v2/inbox/${id}`, this.accessToken); }
    catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  }

  async count(filters: Omit<InboxListFilters, 'limit' | 'cursor'>): Promise<InboxItemCount> {
    return fastapiCall<InboxItemCount>('GET', '/api/v2/inbox/count', this.accessToken, {
      query: { assignee_member_id: filters.assignee_member_id, kind: filters.kind, state: filters.state },
    });
  }

  async resolve(id: string, _orgId: string, input: ResolveInboxItemInput): Promise<InboxItem> {
    return fastapiCall<InboxItem>('POST', `/api/v2/inbox/${id}/resolve`, this.accessToken, { body: input });
  }

  async dismiss(id: string, _orgId: string, input: DismissInboxItemInput): Promise<InboxItem> {
    return fastapiCall<InboxItem>('POST', `/api/v2/inbox/${id}/dismiss`, this.accessToken, { body: input });
  }

  async reassign(id: string, _orgId: string, input: ReassignInboxItemInput): Promise<InboxItem> {
    return fastapiCall<InboxItem>('POST', `/api/v2/inbox/${id}/reassign`, this.accessToken, { body: input });
  }
}
