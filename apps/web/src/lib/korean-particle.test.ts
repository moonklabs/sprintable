import { describe, expect, it } from 'vitest';
import { pickEuroJosa } from './korean-particle';

// story #3698(IA·후속) — 커맨드 팔레트 "{label}(으)로 이동" 동적 조립에서 실측으로 잡힌
// 회귀(알림→"로" 오생성)의 근본 수정. 받침 유무의 기계적 규칙 — 유나 § 대상 아님(어휘
// 선택이 아니라 맞춤법).
describe('pickEuroJosa — 받침 유무에 따른 으로/로 (KS X 1001 종성 표준)', () => {
  it('받침 있음(ㄹ 제외) → 으로', () => {
    expect(pickEuroJosa('알림')).toBe('으로'); // 림=ㅁ받침
    expect(pickEuroJosa('스탠드업')).toBe('으로'); // 업=ㅂ받침
    expect(pickEuroJosa('구성원')).toBe('으로'); // 원=ㄴ받침
    expect(pickEuroJosa('콘텐츠 규칙')).toBe('으로'); // 칙=ㄱ받침
  });

  it('받침 없음 → 로', () => {
    expect(pickEuroJosa('보드')).toBe('로'); // 드=받침없음
    expect(pickEuroJosa('문서')).toBe('로'); // 서=받침없음
    expect(pickEuroJosa('목표')).toBe('로'); // 표=받침없음
    expect(pickEuroJosa('회고')).toBe('로'); // 고=받침없음
    expect(pickEuroJosa('블로그 포스트')).toBe('로'); // 트=받침없음
  });

  it('ㄹ받침은 예외로 로(다른 받침과 다르게)', () => {
    expect(pickEuroJosa('실험실')).toBe('로'); // 실=ㄹ받침
    expect(pickEuroJosa('메일')).toBe('로'); // 일=ㄹ받침
  });

  it('완성형 한글이 없으면(영문 등) 받침 없는 것과 동일하게 로로 안전 폴백', () => {
    expect(pickEuroJosa('Project')).toBe('로');
    expect(pickEuroJosa('')).toBe('로');
  });
});
