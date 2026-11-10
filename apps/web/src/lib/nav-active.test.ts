import { describe, expect, it } from 'vitest';
import { findActiveStaticItemId, isResourceItemActive, screenOwnsListColumn } from './nav-active';

const items = [
  { id: 'inbox', kind: 'static', path: '/inbox?tab=gates' },
  { id: 'workforce', kind: 'static', path: '/organization/workforce' },
  { id: 'runs', kind: 'static', path: '/organization/workforce/runs' },
  { id: 'content', kind: 'static', path: '/content' },
  { id: 'posts', kind: 'static', path: '/content/channel-posts' },
  { id: 'board', kind: 'resource', path: 'flow' },
] as const;
const q = (s: string) => new URLSearchParams(s);

describe('findActiveStaticItemId — 어떤 셸이 그려도 같은 판정', () => {
  it('쿼리 달린 항목은 지금 주소의 같은 키가 같은 값일 때만', () => {
    expect(findActiveStaticItemId(items, '/inbox', q('tab=gates'))).toBe('inbox');
    expect(findActiveStaticItemId(items, '/inbox', q('tab=notifications'))).toBeNull();
    expect(findActiveStaticItemId(items, '/inbox', q(''))).toBeNull();
  });
  it('접두가 겹치면 가장 구체적인 하나만', () => {
    expect(findActiveStaticItemId(items, '/organization/workforce/runs', q(''))).toBe('runs');
    expect(findActiveStaticItemId(items, '/organization/workforce/abc', q(''))).toBe('workforce');
    expect(findActiveStaticItemId(items, '/content/channel-posts', q(''))).toBe('posts');
    expect(findActiveStaticItemId(items, '/content/x', q(''))).toBe('content');
  });
  it('경로 조각 경계를 지킨다(/contents는 /content가 아니다) · 자원 항목은 안 본다', () => {
    expect(findActiveStaticItemId(items, '/contents', q(''))).toBeNull();
    expect(findActiveStaticItemId(items, '/flow', q(''))).toBeNull();
  });
});

describe('isResourceItemActive', () => {
  it('flat · 직접 경로 · 탭줄 경로(extra)까지', () => {
    expect(isResourceItemActive('/flow', 'flow', undefined, undefined)).toBe(true);
    expect(isResourceItemActive('/ws/p/flow/x', 'flow', 'ws', 'p')).toBe(true);
    expect(isResourceItemActive('/ws/p/sprints', 'flow', 'ws', 'p', ['sprints'])).toBe(true);
    expect(isResourceItemActive('/ws/p/docs', 'flow', 'ws', 'p', ['sprints'])).toBe(false);
  });
});

describe('screenOwnsListColumn — 자기 목록 칸을 가진 화면은 셸의 목록 칸을 접는다', () => {
  it('/chats와 그 하위만 (경계를 지킨다)', () => {
    expect(screenOwnsListColumn('/chats')).toBe(true);
    expect(screenOwnsListColumn('/chats/7256d5cc')).toBe(true);
    expect(screenOwnsListColumn('/chatsx')).toBe(false);
    expect(screenOwnsListColumn('/flow')).toBe(false);
    expect(screenOwnsListColumn('/org-briefing')).toBe(false);
  });
});
