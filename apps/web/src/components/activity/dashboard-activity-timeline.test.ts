import { describe, expect, it } from 'vitest';
import { activityActorLabel } from './dashboard-activity-timeline';

function t(key: string): string {
  const table: Record<string, string> = { unknownActor: '시스템' };
  return table[key] ?? key;
}

function tc(key: string): string {
  const table: Record<string, string> = { memberUnnamed: '이름 없는 구성원' };
  return table[key] ?? key;
}

// story #3755(BE·표시명·결함 클래스) — actor_id 없음(진짜 시스템 액션)과 actor_id 있는데
// actor_name만 null(실존 구성원, display_name 미설정)이 예전엔 둘 다 "시스템"으로 뜨던
// 오분류를 activity-log-view.tsx의 auditActorProps와 같은 축으로 갈랐다.
describe('activityActorLabel — story #3755', () => {
  it('actor_id가 없으면(진짜 시스템 액션) 「시스템」', () => {
    expect(activityActorLabel({ actor_id: null, actor_name: null }, t, tc)).toBe('시스템');
  });

  it('actor_id·actor_name 둘 다 있으면 그 이름 그대로', () => {
    expect(activityActorLabel({ actor_id: 'm-1', actor_name: '피오' }, t, tc)).toBe('피오');
  });

  // ⭐되돌리면 RED — actor_id는 있는데(실존 구성원) actor_name이 null이면 이젠 「시스템」이
  // 아니라 「이름 없는 구성원」이어야 한다(둘은 다른 사실 — 전자는 액터가 없다는 거짓말).
  it('⭐actor_id는 있는데 actor_name이 null이면 「이름 없는 구성원」(「시스템」 아님)', () => {
    expect(activityActorLabel({ actor_id: 'm-2', actor_name: null }, t, tc)).toBe('이름 없는 구성원');
  });
});
