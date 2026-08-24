// story #2986(선생님 실사용 발견, 2026-08-24) — 이니셜 폴백 아바타가 어절별 첫 글자를
// 조합하면(라틴 이니셜 관례) 한글에서 우연히 비속어가 조립되는 실사고. 「시스템 발행」→
// 「시」+「발」=「시발」이 정확히 그 사례. 한글(비라틴) 다어절 이름은 첫 어절 첫 글자
// 1자만 쓰도록 고정 — 라틴 다어절(John Smith→JS)은 국제 관례대로 유지.
import { describe, expect, it } from 'vitest';
import { initials } from './format';

describe('initials() — 한글 다어절 이름은 어절 조합 없이 첫 어절 첫 글자만(#2986)', () => {
  it('「시스템 발행」이 「시발」이 아니라 「시」를 반환한다(실사고 재현 고정)', () => {
    expect(initials('시스템 발행')).toBe('시');
    expect(initials('시스템 발행')).not.toBe('시발');
  });

  it('한글 다어절 이름(성+이름 표기) 전반이 첫 어절 첫 글자만 반환한다', () => {
    expect(initials('미르코 페트로비치')).toBe('미');
    expect(initials('페드루 올리베이라')).toBe('페');
    expect(initials('디캄포 은두카쿠')).toBe('디');
  });

  it('한글 단일 어절 이름은 기존과 동일하게 첫 글자 1자를 반환한다(회귀 0)', () => {
    expect(initials('미르코')).toBe('미');
  });

  it('라틴 다어절 이름은 국제 관례대로 각 단어 첫 글자를 조합한다(회귀 0)', () => {
    expect(initials('John Smith')).toBe('JS');
  });

  it('라틴 단일 단어 이름은 기존과 동일하게 앞 2글자를 대문자로 반환한다(회귀 0)', () => {
    expect(initials('claude')).toBe('CL');
  });

  it('빈 이름은 물음표를 반환한다(회귀 0)', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
