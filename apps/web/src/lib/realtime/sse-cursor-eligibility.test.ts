// story #2162 — 재개 커서 오염 방지의 판정 함수. 알려진 B계열(presence·conversation.working)만
// 커서 승격을 막고, 그 외(이름 없는 채널 포함)는 과거 동작 그대로 승격 허용(무회귀).
import { describe, expect, it } from 'vitest';
import { isCursorEligibleEventName } from './sse-cursor-eligibility';

describe('isCursorEligibleEventName', () => {
  it('알려진 B계열(presence)은 커서 승격 불가', () => {
    expect(isCursorEligibleEventName('presence')).toBe(false);
  });

  it('알려진 B계열(conversation.working)은 커서 승격 불가', () => {
    expect(isCursorEligibleEventName('conversation.working')).toBe(false);
  });

  it('알려진 B계열(attention.changed, story #3180)은 커서 승격 불가', () => {
    expect(isCursorEligibleEventName('attention.changed')).toBe(false);
  });

  it('그 외 named 이벤트(예: story.status_changed)는 승격 가능', () => {
    expect(isCursorEligibleEventName('story.status_changed')).toBe(true);
    expect(isCursorEligibleEventName('story.assignee_changed')).toBe(true);
    expect(isCursorEligibleEventName('conversation.message_created')).toBe(true);
    expect(isCursorEligibleEventName('conversation.read')).toBe(true);
  });

  it('이름 없는 채널(undefined)은 과거 동작 그대로 승격 가능(무회귀)', () => {
    expect(isCursorEligibleEventName(undefined)).toBe(true);
  });
});
