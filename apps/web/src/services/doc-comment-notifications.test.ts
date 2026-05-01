import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findMentionedProjectMembers,
  hasExactMemberMention,
  notifyDocCommentMentions,
} from './doc-comment-notifications';

function createSourceSupabaseStub() {
  const docsQuery = {
    select: vi.fn(() => docsQuery),
    eq: vi.fn(() => docsQuery),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: 'doc-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: '운영 가이드',
        deleted_at: null,
      },
      error: null,
    }),
  };

  type TeamMembersResult = {
    data: Array<{ id: string; name: string; user_id: string; type: string; is_active: boolean }>;
    error: null;
  };

  type ThenableTeamMembersQuery = {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    then: Promise<TeamMembersResult>["then"];
  };

  const teamMembersQuery = {} as ThenableTeamMembersQuery;
  teamMembersQuery.select = vi.fn(() => teamMembersQuery);
  teamMembersQuery.eq = vi.fn((field: string, value: unknown) => {
    if (field === 'type') expect(value).toBe('human');
    if (field === 'is_active') expect(value).toBe(true);
    return teamMembersQuery;
  });

  const membersPromise = Promise.resolve({
    data: [
      { id: 'author-1', name: '디디 은와추쿠', user_id: 'user-author', type: 'human', is_active: true },
      { id: 'member-1', name: '파울로 오르테가', user_id: 'user-1', type: 'human', is_active: true },
      { id: 'member-2', name: '까심 아르야', user_id: 'user-2', type: 'human', is_active: true },
      { id: 'member-3', name: '휴면 멤버', user_id: 'user-3', type: 'human', is_active: false },
    ],
    error: null,
  });
  teamMembersQuery.then = membersPromise.then.bind(membersPromise);

  return {
    from: vi.fn((table: string) => {
      if (table === 'docs') return docsQuery;
      if (table === 'team_members') return teamMembersQuery;
      throw new Error(`unexpected table: ${table}`);
    }),
  } as unknown as SupabaseClient;
}

function createAdminSupabaseStub(insertSpy: ReturnType<typeof vi.fn>) {
  return {
    from: vi.fn((table: string) => {
      expect(table).toBe('notifications');
      return { insert: insertSpy };
    }),
  } as unknown as SupabaseClient;
}

describe('hasExactMemberMention', () => {
  it('matches full member names including spaces', () => {
    expect(hasExactMemberMention('검토 부탁드립니다 @파울로 오르테가', '파울로 오르테가')).toBe(true);
  });

  it('ignores email-like strings and partial matches', () => {
    expect(hasExactMemberMention('mail test@파울로 오르테가.com', '파울로 오르테가')).toBe(false);
    expect(hasExactMemberMention('@파울로 오르테가님 확인', '파울로 오르테가')).toBe(false);
  });
});

describe('findMentionedProjectMembers', () => {
  it('returns active human members except the author', () => {
    const members = [
      { id: 'author-1', name: '디디 은와추쿠', user_id: 'user-author', type: 'human', is_active: true },
      { id: 'member-1', name: '파울로 오르테가', user_id: 'user-1', type: 'human', is_active: true },
      { id: 'member-2', name: '까심 아르야', user_id: 'user-2', type: 'human', is_active: true },
      { id: 'member-3', name: 'Sprint Bot', user_id: null, type: 'agent', is_active: true },
    ];

    expect(findMentionedProjectMembers(
      '@파울로 오르테가, @까심 아르야 확인 부탁드리는. @디디 은와추쿠는 이미 작성자인',
      members,
      'author-1',
    )).toEqual([
      members[1],
      members[2],
    ]);
  });
});

describe('notifyDocCommentMentions', () => {
  it('creates doc comment mention notifications with comment deep link references', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null });

    const created = await notifyDocCommentMentions({
      sourceSupabase: createSourceSupabaseStub(),
      adminSupabase: createAdminSupabaseStub(insertSpy),
      docId: 'doc-1',
      commentId: 'comment-1',
      content: '@파울로 오르테가 @까심 아르야 확인 부탁드리는.',
      authorId: 'author-1',
    });

    expect(created).toBe(2);
    expect(insertSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        user_id: 'member-1',
        title: '문서 댓글 멘션',
        reference_type: 'doc_comment',
        reference_id: 'comment-1',
      }),
      expect.objectContaining({
        user_id: 'member-2',
        title: '문서 댓글 멘션',
        reference_type: 'doc_comment',
        reference_id: 'comment-1',
      }),
    ]);
  });

  it('skips inserts when there are no mentioned members', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null });

    const created = await notifyDocCommentMentions({
      sourceSupabase: createSourceSupabaseStub(),
      adminSupabase: createAdminSupabaseStub(insertSpy),
      docId: 'doc-1',
      commentId: 'comment-1',
      content: '일반 댓글인',
      authorId: 'author-1',
    });

    expect(created).toBe(0);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
