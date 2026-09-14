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

  // story #3884(AC2) — t 인자로 로케일 대응(entityTypeLabel의 ko 고정 상수가 en 사용자
  // 에게도 새 나가던 결함 처방). t 생략(위 두 테스트)은 기존 ko-only 폴백 그대로(회귀 0).
  it('t 인자를 주면 그 t()로 해석한다(값은 ko 고정 상수와 동일 — §②-1 정합, 새 낱말 0)', () => {
    const t = (key: string) => ({ entityTypeStory: '스토리', entityTypeDoc: '문서', entityTypeEpic: '에픽', entityTypeTask: '작업' })[key] ?? `⟨missing:${key}⟩`;
    expect(entityTypeLabel('story', t)).toBe('스토리');
    expect(entityTypeLabel('doc', t)).toBe('문서');
    expect(entityTypeLabel('epic', t)).toBe('에픽');
    expect(entityTypeLabel('task', t)).toBe('작업');
  });

  it('t 인자를 en t()로 주면 Title Case 영단어를 낸다(§②-1 관례)', () => {
    const tEn = (key: string) => ({ entityTypeStory: 'Story', entityTypeDoc: 'Doc', entityTypeEpic: 'Epic', entityTypeTask: 'Task' })[key] ?? `⟨missing:${key}⟩`;
    expect(entityTypeLabel('story', tEn)).toBe('Story');
    expect(entityTypeLabel('story')).toBe('스토리'); // t 생략 시 여전히 ko-only(회귀 0).
  });

  it('t 인자를 줘도 모르는 종류(t 키 매핑이 없는 종류)는 ko-only 폴백으로 떨어진다(지어내지 않음)', () => {
    const t = (key: string) => `⟨missing:${key}⟩`;
    expect(entityTypeLabel('sprint', t)).toBe('sprint');
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
