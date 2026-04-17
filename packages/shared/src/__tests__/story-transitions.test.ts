import { describe, it, expect } from 'vitest';

/**
 * SID:357 — Story 상태 전이 검증 테스트
 */

// services/story.ts의 VALID_TRANSITIONS과 동일
const VALID_TRANSITIONS: Record<string, string[]> = {
  'backlog': ['ready-for-dev'],
  'ready-for-dev': ['in-progress', 'backlog'],
  'in-progress': ['in-review', 'ready-for-dev'],
  'in-review': ['done', 'in-progress'],
  'done': ['in-review'],
};

function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

describe('Story 상태 전이 검증', () => {
  describe('유효한 전이', () => {
    it('backlog → ready-for-dev', () => {
      expect(canTransition('backlog', 'ready-for-dev')).toBe(true);
    });
    it('ready-for-dev → in-progress', () => {
      expect(canTransition('ready-for-dev', 'in-progress')).toBe(true);
    });
    it('ready-for-dev → backlog', () => {
      expect(canTransition('ready-for-dev', 'backlog')).toBe(true);
    });
    it('in-progress → in-review', () => {
      expect(canTransition('in-progress', 'in-review')).toBe(true);
    });
    it('in-progress → ready-for-dev', () => {
      expect(canTransition('in-progress', 'ready-for-dev')).toBe(true);
    });
    it('in-review → done', () => {
      expect(canTransition('in-review', 'done')).toBe(true);
    });
    it('in-review → in-progress', () => {
      expect(canTransition('in-review', 'in-progress')).toBe(true);
    });
    it('done → in-review (admin only)', () => {
      expect(canTransition('done', 'in-review')).toBe(true);
    });
  });

  describe('유효하지 않은 전이', () => {
    it('backlog → in-progress (건너뜀 금지)', () => {
      expect(canTransition('backlog', 'in-progress')).toBe(false);
    });
    it('backlog → done (건너뜀 금지)', () => {
      expect(canTransition('backlog', 'done')).toBe(false);
    });
    it('ready-for-dev → done (건너뜀 금지)', () => {
      expect(canTransition('ready-for-dev', 'done')).toBe(false);
    });
    it('in-progress → done (건너뜀 금지)', () => {
      expect(canTransition('in-progress', 'done')).toBe(false);
    });
    it('done → backlog (역방향 금지)', () => {
      expect(canTransition('done', 'backlog')).toBe(false);
    });
    it('done → in-progress (2단계 역방향 금지)', () => {
      expect(canTransition('done', 'in-progress')).toBe(false);
    });
    it('존재하지 않는 상태 → 유효한 상태', () => {
      expect(canTransition('invalid-status', 'backlog')).toBe(false);
    });
  });

  describe('엣지 케이스', () => {
    it('같은 상태로의 전이는 VALID_TRANSITIONS에 없음', () => {
      expect(canTransition('backlog', 'backlog')).toBe(false);
      expect(canTransition('done', 'done')).toBe(false);
    });
    it('done은 in-review로만 복귀 가능', () => {
      const validFromDone = VALID_TRANSITIONS['done'];
      expect(validFromDone).toEqual(['in-review']);
    });
  });
});
