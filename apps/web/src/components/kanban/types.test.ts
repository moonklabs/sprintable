// story #2133 — assignee_id(단일)/assignee_ids(배열) 이중표현이 생산처마다 손으로
// 맞춰지다 하루 2회(#2384·#2130) 동일 클래스로 어긋났다. normalizeAssigneePatch가 항상
// 정합된 patch를 반환하는지 조합별로 고정한다(회귀 방지의 실질).
import { describe, expect, it } from 'vitest';
import { normalizeAssigneePatch } from './types';

describe('normalizeAssigneePatch', () => {
  it('assignee_id 단일 입력 → assignee_ids로 파생된다', () => {
    expect(normalizeAssigneePatch({ assignee_id: 'm1' })).toEqual({
      assignee_id: 'm1',
      assignee_ids: ['m1'],
    });
  });

  it('assignee_ids 배열 입력 → assignee_id는 배열의 첫 원소로 파생된다', () => {
    expect(normalizeAssigneePatch({ assignee_ids: ['m1', 'm2'] })).toEqual({
      assignee_id: 'm1',
      assignee_ids: ['m1', 'm2'],
    });
  });

  it('빈 배열 입력 → 둘 다 빈 상태로 정합된다', () => {
    expect(normalizeAssigneePatch({ assignee_ids: [] })).toEqual({
      assignee_id: null,
      assignee_ids: [],
    });
  });

  it('assignee_id도 null, assignee_ids도 없는 입력 → 둘 다 빈 상태', () => {
    expect(normalizeAssigneePatch({ assignee_id: null })).toEqual({
      assignee_id: null,
      assignee_ids: [],
    });
    expect(normalizeAssigneePatch({})).toEqual({
      assignee_id: null,
      assignee_ids: [],
    });
  });

  it('assignee_id와 assignee_ids가 함께 오면 assignee_ids(배열)가 SSOT — assignee_id는 무시되고 배열 첫 원소로 재계산된다', () => {
    // #2130 SSE payload처럼 assignee_id·assignees(배열)가 동시에 오는 경우도, 배열이 있으면
    // 배열을 기준으로 정합시켜 두 필드가 서로 다른 값을 가리키는 상태를 원천 봉쇄한다.
    expect(normalizeAssigneePatch({ assignee_id: 'stale', assignee_ids: ['fresh'] })).toEqual({
      assignee_id: 'fresh',
      assignee_ids: ['fresh'],
    });
  });

  it('미지 멤버(memberMap에 없는 id)도 그대로 정합된 patch를 낸다 — 렌더 실패와 state 정합은 별개', () => {
    expect(normalizeAssigneePatch({ assignee_ids: ['unknown-member'] })).toEqual({
      assignee_id: 'unknown-member',
      assignee_ids: ['unknown-member'],
    });
  });

  it('assignee_ids에 falsy 값이 섞여 있어도 걸러낸다', () => {
    expect(normalizeAssigneePatch({ assignee_ids: ['m1', '', 'm2'] })).toEqual({
      assignee_id: 'm1',
      assignee_ids: ['m1', 'm2'],
    });
  });
});
