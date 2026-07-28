/**
 * story #2263(C-5) ㉠㉡㉢ — `#` 엔티티 피커가 종류로 묶여 보이고, 라벨이 글자로 우선하며,
 * 화면이 모르는 종류도 "정상 경로"로 그려지는지(조용한 Hash 실패 대신)를 고정한다.
 */
import { describe, expect, it } from 'vitest';
import { entityTypeLabel, groupEntitiesByType } from './chat-input';

interface EntityResult {
  entity_type: string;
  entity_id: string;
  title: string;
  status: string | null;
}

function er(entity_type: string, entity_id: string, title = entity_id): EntityResult {
  return { entity_type, entity_id, title, status: null };
}

describe('entityTypeLabel — ㉠ 종류를 글자로, ㉢ 모르는 종류도 정상 경로', () => {
  it('알려진 종류는 한글 라벨을 낸다', () => {
    expect(entityTypeLabel('story')).toBe('스토리');
    expect(entityTypeLabel('doc')).toBe('문서');
    expect(entityTypeLabel('epic')).toBe('에픽');
    expect(entityTypeLabel('task')).toBe('작업');
  });

  it('⛔모르는 종류(sprint 등 미래 registry 확장)도 빈 문자열/물음표 없이 원문 그대로 보인다', () => {
    expect(entityTypeLabel('sprint')).toBe('sprint');
    expect(entityTypeLabel('hypothesis')).toBe('hypothesis');
    expect(entityTypeLabel('')).toBe('');
  });
});

describe('groupEntitiesByType — ㉡ 종류로 묶되 열은 안 나눈다(단일 순서 배열)', () => {
  it('뒤섞인 종류를 첫 등장 순서 기준으로 묶어 재배열한다', () => {
    const mixed = [er('story', 's1'), er('doc', 'd1'), er('story', 's2'), er('doc', 'd2'), er('epic', 'e1')];
    const grouped = groupEntitiesByType(mixed);
    expect(grouped.map((r) => `${r.entity_type}:${r.entity_id}`)).toEqual([
      'story:s1', 'story:s2', 'doc:d1', 'doc:d2', 'epic:e1',
    ]);
  });

  it('그룹 내부 순서(관련도/최신순 등 BE가 준 순서)는 보존한다', () => {
    const mixed = [er('doc', 'd-newest'), er('story', 's1'), er('doc', 'd-older')];
    const grouped = groupEntitiesByType(mixed);
    const docIds = grouped.filter((r) => r.entity_type === 'doc').map((r) => r.entity_id);
    expect(docIds).toEqual(['d-newest', 'd-older']);
  });

  it('모르는 종류가 섞여도 그대로 하나의 그룹으로 묶인다(하드코딩된 타입 나열에 안 걸림)', () => {
    const mixed = [er('sprint', 'sp1'), er('story', 's1'), er('sprint', 'sp2')];
    const grouped = groupEntitiesByType(mixed);
    expect(grouped.map((r) => `${r.entity_type}:${r.entity_id}`)).toEqual([
      'sprint:sp1', 'sprint:sp2', 'story:s1',
    ]);
  });

  it('빈 배열은 빈 배열을 낸다', () => {
    expect(groupEntitiesByType([])).toEqual([]);
  });

  it('종류가 하나뿐이면 원래 순서 그대로다', () => {
    const single = [er('story', 's1'), er('story', 's2'), er('story', 's3')];
    expect(groupEntitiesByType(single)).toEqual(single);
  });
});
