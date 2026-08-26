import { describe, expect, it } from 'vitest';
import { parseStoryCardTitle } from './story-card-title';

describe('parseStoryCardTitle (story #32dcc294, v2 #2 카드 재설계)', () => {
  it('선두 [태그]를 categoryTag로 분리하고 나머지를 lead로 verbatim 반환한다', () => {
    expect(parseStoryCardTitle('[Workcell·콘텐츠 ③] goal/DoD 구조화 소스 트랙')).toEqual({
      categoryTag: 'Workcell·콘텐츠 ③',
      lead: 'goal/DoD 구조화 소스 트랙',
    });
  });

  it('[태그]가 없으면 categoryTag=null, 전체를 lead로 verbatim 반환한다', () => {
    expect(parseStoryCardTitle('평범한 제목입니다')).toEqual({ categoryTag: null, lead: '평범한 제목입니다' });
  });

  it('#번호만 있는 제목(대괄호 없음)도 훼손 없이 verbatim 통과한다', () => {
    expect(parseStoryCardTitle('#1234 참조만 있는 제목')).toEqual({ categoryTag: null, lead: '#1234 참조만 있는 제목' });
  });

  it('태그만 있고 남는 제목이 없으면 원문 전체를 lead로 폴백한다(빈 제목 방지)', () => {
    expect(parseStoryCardTitle('[태그만있음]')).toEqual({ categoryTag: null, lead: '[태그만있음]' });
  });

  it('첫 대괄호 하나만 분리 — 두 번째 대괄호는 lead 안에 verbatim 보존', () => {
    expect(parseStoryCardTitle('[A] [B] 제목')).toEqual({ categoryTag: 'A', lead: '[B] 제목' });
  });

  it('앞뒤 공백을 트림한다', () => {
    expect(parseStoryCardTitle('  [태그]   본문   ')).toEqual({ categoryTag: '태그', lead: '본문' });
  });

  it('빈 문자열은 categoryTag=null, lead=빈 문자열', () => {
    expect(parseStoryCardTitle('')).toEqual({ categoryTag: null, lead: '' });
  });
});
