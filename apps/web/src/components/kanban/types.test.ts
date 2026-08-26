// story #2133 — assignee_id(단일)/assignee_ids(배열) 이중표현이 생산처마다 손으로
// 맞춰지다 하루 2회(#2384·#2130) 동일 클래스로 어긋났다. normalizeAssigneePatch가 항상
// 정합된 patch를 반환하는지 조합별로 고정한다(회귀 방지의 실질).
import { describe, expect, it } from 'vitest';
import { normalizeAssigneePatch, TRUST_COLUMNS, TRUST_COLUMN_TO_STATUS } from './types';

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

// story #2933 H4(P0-H, v4 아티팩트 e65f1016 §C) — 컬럼 순서·잠금·매핑표가 그 §C 표와 정확히
// 일치하는지 데이터 레벨로 고정. 렌더 테스트(kanban-board.test.tsx)와 상호보완 — 여기는
// 실수로 순서/잠금 플래그가 바뀌면 즉시 실패하는 얕은 회귀가드.
describe('TRUST_COLUMNS / TRUST_COLUMN_TO_STATUS(story #2933 H4)', () => {
  it('7컬럼이 §C 표 순서 그대로다', () => {
    expect(TRUST_COLUMNS.map((c) => c.id)).toEqual([
      'queued', 'running', 'needs_input', 'claimed_done', 'verified', 'merge_ready', 'done',
    ]);
  });

  it('파생 3개(needs_input/verified/merge_ready)만 locked=true — 나머지 4개는 settable(locked=false)', () => {
    const lockedIds = TRUST_COLUMNS.filter((c) => c.locked).map((c) => c.id);
    expect(lockedIds.sort()).toEqual(['merge_ready', 'needs_input', 'verified'].sort());
  });

  it('TRUST_COLUMN_TO_STATUS는 settable 4개만 키로 갖는다(파생 3개는 드롭 자체가 없어 매핑 불필요)', () => {
    expect(Object.keys(TRUST_COLUMN_TO_STATUS).sort()).toEqual(['claimed_done', 'done', 'queued', 'running'].sort());
  });

  it('queued 드롭 = ready-for-dev(PO 확定④ — backlog 강등 안 함)', () => {
    expect(TRUST_COLUMN_TO_STATUS.queued).toBe('ready-for-dev');
  });

  it('running/claimed_done/done 드롭은 각각 in-progress/in-review/done', () => {
    expect(TRUST_COLUMN_TO_STATUS.running).toBe('in-progress');
    expect(TRUST_COLUMN_TO_STATUS.claimed_done).toBe('in-review');
    expect(TRUST_COLUMN_TO_STATUS.done).toBe('done');
  });
});
