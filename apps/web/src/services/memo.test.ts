import { describe, it, expect } from 'vitest';
import { MemoService } from './memo';

describe('MemoService.getByIdWithDetails', () => {
  it('enriches memo details with replies, reply summary, project name, timeline, and linked docs', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'memos') {
          return {
            select() { return this; },
            eq() { return this; },
            is() { return this; },
          single: async () => ({
              data: {
                id: 'memo-1',
                project_id: 'project-1',
                org_id: 'org-1',
                title: 'Memo title',
                content: 'Memo body',
                status: 'open',
                memo_type: 'decision',
                created_by: 'user-1',
                assigned_to: 'user-2',
                created_at: '2026-04-05T00:00:00.000Z',
                supersedes_id: 'memo-0',
              },
              error: null,
            }),
          };
        }
        if (table === 'memo_replies') {
          return {
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                { id: 'reply-1', memo_id: 'memo-1', content: 'First reply', created_by: 'user-2', review_type: 'comment', created_at: '2026-04-05T01:00:00.000Z' },
                { id: 'reply-2', memo_id: 'memo-1', content: 'Second reply', created_by: 'user-3', review_type: 'comment', created_at: '2026-04-05T02:00:00.000Z' },
              ],
              error: null,
            }).then(resolve),
          };
        }
        if (table === 'projects') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({ data: { id: 'project-1', name: 'Project Alpha' }, error: null }),
          };
        }
        if (table === 'memo_doc_links') {
          return {
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                { doc_id: 'doc-1', created_at: '2026-04-05T03:00:00.000Z' },
              ],
              error: null,
            }).then(resolve),
          };
        }
        if (table === 'memo_reads') {
          return {
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                { team_member_id: 'reader-1', read_at: '2026-04-05T03:10:00.000Z' },
                { team_member_id: 'reader-2', read_at: '2026-04-05T03:20:00.000Z' },
              ],
              error: null,
            }).then(resolve),
          };
        }
        if (table === 'docs') {
          return {
            select() { return this; },
            eq() { return this; },
            in() { return this; },
            order() { return this; },
            limit() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                { id: 'doc-1', title: 'Linked doc', slug: 'linked-doc' },
              ],
              error: null,
            }).then(resolve),
          };
        }
        if (table === 'team_members') {
          return {
            select() { return this; },
            eq() { return this; },
            in() { return this; },
            single: async () => ({ data: { id: 'reader-1', name: 'Reader One' }, error: null }),
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                { id: 'reader-1', name: 'Reader One' },
                { id: 'reader-2', name: 'Reader Two' },
              ],
              error: null,
            }).then(resolve),
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const service = MemoService.fromSupabase(supabase);
    const memo = await service.getByIdWithDetails('memo-1');

    expect(memo.reply_count).toBe(2);
    expect(memo.latest_reply_at).toBe('2026-04-05T02:00:00.000Z');
    expect(memo.project_name).toBe('Project Alpha');
    expect(memo.timeline?.[0]?.label).toContain('created');
    expect(memo.linked_docs?.[0]?.slug).toBe('linked-doc');
    expect(memo.readers?.map((reader: { name: string }) => reader.name)).toEqual(['Reader One', 'Reader Two']);
  });
});

describe('MemoService.create', () => {
  it('rejects created_by values outside the current project scope', async () => {
    let teamMemberIdFilter: string | null = null;

    const supabase = {
      from(table: string) {
        if (table === 'projects') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({ data: { id: 'project-1', org_id: 'org-1' }, error: null }),
          };
        }

        if (table === 'team_members') {
          return {
            select() { return this; },
            eq(column: string, value: string | boolean) {
              if (column === 'id' && typeof value === 'string') {
                teamMemberIdFilter = value;
              }
              return this;
            },
            single: async () => ({
              data: teamMemberIdFilter === 'author-in-project' ? { id: 'author-in-project' } : null,
              error: null,
            }),
          };
        }

        if (table === 'memos') {
          return {
            insert() { return this; },
            select() { return this; },
            single: async () => ({ data: { id: 'memo-new' }, error: null }),
          };
        }

        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          single: async () => ({ data: null, error: null }),
        };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const service = MemoService.fromSupabase(supabase);

    await expect(service.create({
      project_id: 'project-1',
      org_id: 'org-1',
      content: 'Slack message',
      created_by: 'author-from-other-project',
    })).rejects.toThrow('created_by must be an active team member in the same project');
  });
});

describe('MemoService.linkDoc and markRead', () => {
  it('links a doc in the same project and marks the memo as read', async () => {
    let linkedPayload: Record<string, unknown> | null = null;
    let readPayload: Record<string, unknown> | null = null;

    const supabase = {
      from(table: string) {
        if (table === 'memos') {
          return {
            select() { return this; },
            eq() { return this; },
            is() { return this; },
          single: async () => ({
              data: {
                id: 'memo-1',
                project_id: 'project-1',
                org_id: 'org-1',
                status: 'open',
                created_by: 'author-1',
                content: 'Memo body',
                memo_type: 'memo',
                created_at: '2026-04-05T00:00:00.000Z',
              },
              error: null,
            }),
          };
        }

        if (table === 'team_members') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({ data: { id: 'author-1' }, error: null }),
            in() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({ data: [{ id: 'reader-1', name: 'Reader One' }], error: null }).then(resolve),
          };
        }

        if (table === 'docs') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({ data: { id: 'doc-1', project_id: 'project-1', org_id: 'org-1' }, error: null }),
          };
        }

        if (table === 'memo_doc_links') {
          return {
            upsert(payload: Record<string, unknown>) { linkedPayload = payload; return this; },
            select() { return this; },
            single: async () => ({ data: { id: 'link-1', ...(linkedPayload ?? {}) }, error: null }),
          };
        }

        if (table === 'memo_reads') {
          return {
            upsert(payload: Record<string, unknown>) { readPayload = payload; return this; },
            select() { return this; },
            single: async () => ({ data: { id: 'read-1', ...(readPayload ?? {}) }, error: null }),
          };
        }

        return {
          select() { return this; },
          eq() { return this; },
          single: async () => ({ data: null, error: null }),
        };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const service = MemoService.fromSupabase(supabase);

    await expect(service.linkDoc('memo-1', 'doc-1', 'author-1')).resolves.toMatchObject({ doc_id: 'doc-1', memo_id: 'memo-1' });
    await expect(service.markRead('memo-1', 'author-1')).resolves.toMatchObject({ memo_id: 'memo-1', team_member_id: 'author-1' });
    expect(linkedPayload).toMatchObject({ memo_id: 'memo-1', doc_id: 'doc-1', created_by: 'author-1' });
    expect(readPayload).toMatchObject({ memo_id: 'memo-1', team_member_id: 'author-1' });
  });

  it('treats missing memo_reads as optional when marking memo as read during rollout', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'memos') {
          return {
            select() { return this; },
            eq() { return this; },
            is() { return this; },
          single: async () => ({
              data: {
                id: 'memo-1',
                org_id: 'org-1',
                project_id: 'project-1',
                title: 'Memo title',
                content: 'Memo body',
                created_by: 'author-1',
              },
              error: null,
            }),
          };
        }

        if (table === 'team_members') {
          return {
            select() { return this; },
            eq() { return this; },
            in() { return this; },
            single: async () => ({ data: { id: 'author-1', name: 'Author One' }, error: null }),
          };
        }

        if (table === 'memo_reads') {
          return {
            upsert() { return this; },
            select() { return this; },
            single: async () => ({
              data: null,
              error: { code: 'PGRST205', message: "Could not find the table 'public.memo_reads' in the schema cache" },
            }),
          };
        }

        return {
          select() { return this; },
          eq() { return this; },
          single: async () => ({ data: null, error: null }),
        };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const service = MemoService.fromSupabase(supabase);
    await expect(service.markRead('memo-1', 'author-1')).resolves.toMatchObject({
      memo_id: 'memo-1',
      team_member_id: 'author-1',
    });
  });
});


describe('MemoService.list', () => {
  it('treats missing memo_reads as optional during rollout', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'memos') {
          return {
            select() { return this; },
            eq() { return this; },
            is() { return this; },
          order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                {
                  id: 'memo-1',
                  project_id: 'project-1',
                  title: 'Memo title',
                  content: 'Memo body',
                  status: 'open',
                  memo_type: 'decision',
                  created_by: 'user-1',
                  assigned_to: 'user-2',
                  created_at: '2026-04-05T00:00:00.000Z',
                },
              ],
              error: null,
            }).then(resolve),
          };
        }

        if (table === 'memo_replies') {
          return {
            select() { return this; },
            in() { return this; },
            order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [{ memo_id: 'memo-1', created_at: '2026-04-05T02:00:00.000Z' }],
              error: null,
            }).then(resolve),
          };
        }

        if (table === 'projects') {
          return {
            select() { return this; },
            in() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [{ id: 'project-1', name: 'Project Alpha' }],
              error: null,
            }).then(resolve),
          };
        }

        if (table === 'memo_reads') {
          return {
            select() { return this; },
            in() { return this; },
            order() { return this; },
            then: (resolve: (value: { data: null; error: { code: string; message: string } }) => void) => Promise.resolve({
              data: null,
              error: { code: 'PGRST205', message: "Could not find the table 'public.memo_reads' in the schema cache" },
            }).then(resolve),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const service = MemoService.fromSupabase(supabase);
    const memos = await service.list({ project_id: 'project-1' });

    expect(memos).toEqual([
      expect.objectContaining({
        id: 'memo-1',
        project_name: 'Project Alpha',
        reply_count: 1,
        latest_reply_at: '2026-04-05T02:00:00.000Z',
        readers: [],
      }),
    ]);
  });

  it('builds memo summaries with batched reply and read lookups', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'memos') {
          return {
            select() { return this; },
            eq() { return this; },
            is() { return this; },
          order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                {
                  id: 'memo-1',
                  project_id: 'project-1',
                  title: 'Memo title',
                  content: 'Memo body',
                  status: 'open',
                  memo_type: 'decision',
                  created_by: 'user-1',
                  assigned_to: 'user-2',
                  created_at: '2026-04-05T00:00:00.000Z',
                },
              ],
              error: null,
            }).then(resolve),
          };
        }

        if (table === 'memo_replies') {
          return {
            select() { return this; },
            in(column: string, values: string[]) {
              expect(column).toBe('memo_id');
              expect(values).toEqual(['memo-1']);
              return this;
            },
            order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                { memo_id: 'memo-1', created_at: '2026-04-05T01:00:00.000Z' },
                { memo_id: 'memo-1', created_at: '2026-04-05T02:00:00.000Z' },
              ],
              error: null,
            }).then(resolve),
          };
        }

        if (table === 'projects') {
          return {
            select() { return this; },
            in(column: string, values: string[]) {
              expect(column).toBe('id');
              expect(values).toEqual(['project-1']);
              return this;
            },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [{ id: 'project-1', name: 'Project Alpha' }],
              error: null,
            }).then(resolve),
          };
        }

        if (table === 'memo_reads') {
          return {
            select() { return this; },
            in(column: string, values: string[]) {
              expect(column).toBe('memo_id');
              expect(values).toEqual(['memo-1']);
              return this;
            },
            order() { return this; },
            then: (resolve: (value: { data: unknown[]; error: null }) => void) => Promise.resolve({
              data: [
                { memo_id: 'memo-1', team_member_id: 'reader-1', read_at: '2026-04-05T03:10:00.000Z' },
              ],
              error: null,
            }).then(resolve),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const service = MemoService.fromSupabase(supabase);
    const memos = await service.list({ project_id: 'project-1' });

    expect(memos).toEqual([
      expect.objectContaining({
        id: 'memo-1',
        project_name: 'Project Alpha',
        reply_count: 2,
        latest_reply_at: '2026-04-05T02:00:00.000Z',
        readers: [
          expect.objectContaining({ id: 'reader-1', read_at: '2026-04-05T03:10:00.000Z' }),
        ],
      }),
    ]);
  });
});
