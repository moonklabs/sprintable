
import { describe, expect, it } from 'vitest';
import {
  findMentionedProjectMembers,
  hasExactMemberMention,
} from './doc-comment-notifications';

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
