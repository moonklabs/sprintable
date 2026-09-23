// story #4201 — 사용자 화면 문구(messages ko·en)에 내부어 0. 백엔드 플랫폼 프리셋 가드
// (tests/test_4188_platform_preset_user_copy_guard_realdb.py _FORBIDDEN, 유나 확정)와 같은 낱말표를 FE 카탈로그에도 건다.
// 해제 조건: 그 말이 제품 낱말로 채택될 때(유나 확정)만 줄을 지운다.
// «전이»는 «…전이에요»(= ~전이에요, before)와 보드의 «상태 전이»(제품 낱말)로 쓰여 여기서 막지 않는다.
import { describe, expect, it } from 'vitest';
import ko from '../messages/ko.json';
import en from '../messages/en.json';

// 라틴 약어는 한글이 바로 붙어도 잡히게(«BYOA를») — \b는 한글을 단어 글자로 봐 놓친다.
const latin = (w: string) => new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`);

export const FORBIDDEN: [RegExp, string][] = [
  [latin('BYOA'), '내부 전략 약어 — «에이전트 연결»'],
  [/실탄/, '팀 은어(유료 생성 비용) — «유료»'],
  [/무과금/, '게임 은어 — «무료»'],
  [/딸깍/, '팀 은어(클릭 한 번) — «승인»'],
  // 까디르 QA(PR #4561): U+4E00–9FFF만 보면 호환 한자(U+F900–FAFF — 한글 IME 한자 변환이 내기도 함)·확장 A·B를
  // 놓친다 — 유니코드 Ideographic 속성 전체로.
  [/\p{Ideographic}/u, '한자 혼용(팀 채팅의 «확定»류)'],
];

function* strings(obj: unknown, path = ''): Generator<[string, string]> {
  if (typeof obj === 'string') { yield [path, obj]; return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) yield* strings(v, path ? `${path}.${k}` : k);
  }
}

export function findJargon(catalog: unknown): string[] {
  const hits: string[] = [];
  for (const [key, value] of strings(catalog)) {
    for (const [re, why] of FORBIDDEN) if (re.test(value)) hits.push(`${key}: «${value}» — ${why}`);
  }
  return hits;
}

describe('사용자 화면 문구에 내부어 0(story #4201)', () => {
  it.each([['ko', ko], ['en', en]])('%s', (_lang, catalog) => {
    expect(findJargon(catalog)).toEqual([]);
  });

  it('가드 자체 — 한글이 붙은 약어도, 은어도 잡는다', () => {
    expect(findJargon({ a: 'BYOA를 허용하면' })).toHaveLength(1);
    expect(findJargon({ a: '실탄 예산' })).toHaveLength(1);
    expect(findJargon({ a: 'BYOAX 아님' })).toHaveLength(0);
  });

  it.each([
    ['기본 한자', '確'],
    ['호환 한자 U+F90A', '\uF90A'],
    ['확장 A U+3400', '\u3400'],
    ['확장 B U+20000', '\u{20000}'],
  ])('한자 가드 범위 — %s', (_n, word) => {
    expect(findJargon({ a: `문구 ${word} 끝` })).toHaveLength(1);
  });
});
