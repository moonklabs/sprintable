// [SID:4311 PR 3] 스탠드업 스토리 담당 칩 라벨 — 담당 없음 · 이름 빔 · 표에 없음 · 받는 중을 가르고, 같은 이름 둘은 꼬리.
import { describe, expect, it } from 'vitest';
import { storyAssigneeChipLabels } from './story-assignee-label';

const tc = (k: string) => ({ memberUnnamed: '이름 없는 구성원', memberUnknown: '알 수 없는 구성원' } as Record<string, string>)[k] ?? k;
const table: Record<string, string | null> = { 'e75ca548-1': '송윤재', '2fd14616-2': '송윤재', 'm-anna': '안나', 'm-noname': null };

describe('storyAssigneeChipLabels([SID:4311 PR 3])', () => {
  it('담당 없음 · 이름 · 이름 빔 · 표에 없음을 가른다(예전엔 셋 다 «알 수 없음»)', () => {
    const label = storyAssigneeChipLabels([{ assignee_id: null }, { assignee_id: 'm-anna' }, { assignee_id: 'm-noname' }, { assignee_id: 'm-gone' }], table, tc, '담당자 없음');
    expect(label(null)).toBe('담당자 없음');
    expect(label(undefined)).toBe('담당자 없음');
    expect(label('m-anna')).toBe('안나');
    expect(label('m-noname')).toBe('이름 없는 구성원');
    expect(label('m-gone')).toBe('알 수 없는 구성원');
  });

  it('같은 이름 서로 다른 담당 둘 → «· ID 앞 8자» · 같은 사람 여러 칩 = 같은 꼬리 · 목록에 없는 id는 꼬리 없음', () => {
    const label = storyAssigneeChipLabels([{ assignee_id: 'e75ca548-1' }, { assignee_id: '2fd14616-2' }, { assignee_id: 'e75ca548-1' }, { assignee_id: 'm-anna' }], table, tc, '담당자 없음');
    expect(label('e75ca548-1')).toBe('송윤재 · e75ca548');
    expect(label('2fd14616-2')).toBe('송윤재 · 2fd14616');
    expect(label('m-anna')).toBe('안나');
  });

  it('표를 받는 중이면 빈 글자(«알 수 없음»이 먼저 서지 않음) · 꼬리도 없음', () => {
    const label = storyAssigneeChipLabels([{ assignee_id: 'm-gone' }], {}, tc, '담당자 없음', { loaded: false });
    expect(label('m-gone')).toBe('');
  });
});
