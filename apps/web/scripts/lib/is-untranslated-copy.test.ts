import { describe, expect, it } from 'vitest';
import { isUntranslatedCopy } from './is-untranslated-copy';

describe('isUntranslatedCopy — story #3880 CHANGES ④ 셀프테스트', () => {
  it('⭐구두점 섞인 실 사고 문자열들 → true(옛 ASCII_WORD_RE가 놓치던 자리)', () => {
    expect(isUntranslatedCopy('Enter document slug or ID…')).toBe(true);
    expect(isUntranslatedCopy('Loading document…')).toBe(true);
    expect(isUntranslatedCopy('Circular embed detected — a document cannot embed itself.')).toBe(true);
  });

  it('⭐단순 영단어/구 → true(기존 클래스 그대로 유지)', () => {
    expect(isUntranslatedCopy('Brief')).toBe(true);
    expect(isUntranslatedCopy('Blocked by')).toBe(true);
  });

  it('음성대조 — 한글이 조금이라도 섞이면 false(다른 클래스, 이 술어 스코프 밖)', () => {
    expect(isUntranslatedCopy('이 문서는 draft 상태입니다')).toBe(false);
    expect(isUntranslatedCopy('지식 · KNOWLEDGE BASE')).toBe(false);
  });

  it('음성대조 — 순수 한글은 false', () => {
    expect(isUntranslatedCopy('완료 기준')).toBe(false);
  });

  it('음성대조 — 순수 숫자/구두점만(영문 단어 0)은 false', () => {
    expect(isUntranslatedCopy('42')).toBe(false);
    expect(isUntranslatedCopy('—')).toBe(false);
    expect(isUntranslatedCopy('...')).toBe(false);
  });

  it('음성대조 — 빈 문자열/공백만은 false', () => {
    expect(isUntranslatedCopy('')).toBe(false);
    expect(isUntranslatedCopy('   ')).toBe(false);
  });

  it('음성대조 — 1글자 단어는 «영문 단어»로 안 침(ENGLISH_WORD_RE {2,}) — 나머지가 필러뿐이면 false', () => {
    expect(isUntranslatedCopy('A')).toBe(false);
  });

  // 구두점 집합 좁힘 회귀가드 — 1차 구현이 오탐 낸 기술 토큰 클래스(이메일·URL·HTML
  // 엔티티·해시 조각)는 false여야 한다(자연어 문장이 아님, 별도 축의 몫).
  it('음성대조 — 기술 토큰(이메일·URL·HTML 엔티티·해시 조각)은 false(구두점 집합 밖)', () => {
    expect(isUntranslatedCopy('legal@moonklabs.com')).toBe(false);
    expect(isUntranslatedCopy('sprintable.app/')).toBe(false);
    expect(isUntranslatedCopy('&ldquo;')).toBe(false);
    expect(isUntranslatedCopy('PR #')).toBe(false);
  });
});
