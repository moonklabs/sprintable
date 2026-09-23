// story #4197 — 말풍선 주석 제거 보조 함수(평문 경로 줄 단위 제거 · «빈 본문» 보수 판정).
import { describe, expect, it } from 'vitest';
import { isCommentOnlyContent, stripHtmlCommentsFromPlainText } from './remark-strip-html-comments';

describe('stripHtmlCommentsFromPlainText', () => {
  it.each([
    ['첫 줄', '<!-- a -->\n본문', '본문'],
    ['앞머리 뒤 빈 줄까지', '<!-- a -->\n\n본문', '본문'],
    ['가운데 줄', '첫\n<!-- a -->\n둘째', '첫\n둘째'],
    ['끝 줄', '본문\n<!-- a -->', '본문'],
    ['줄 가운데 = 공백 하나', '앞 <!-- a --> 뒤', '앞 뒤'],
    ['안 닫힌 주석은 끝까지', '보임 <!-- f4\n다음', '보임'],
  ])('%s', (_n, input, expected) => {
    expect(stripHtmlCommentsFromPlainText(input)).toBe(expected);
  });
});

describe('isCommentOnlyContent', () => {
  it('주석만 있으면 true', () => { expect(isCommentOnlyContent('<!-- a -->\n\n<!-- b')).toBe(true); });
  it('글자가 남으면 false', () => { expect(isCommentOnlyContent('<!-- a --> 본문')).toBe(false); });
  it('주석이 없으면 false', () => { expect(isCommentOnlyContent('')).toBe(false); });
  it('주석 «안»의 백틱·~~~는 코드가 아니다 — 주석만이면 true(PR #4559 잔여 4)', () => {
    expect(isCommentOnlyContent('<!-- 예: `code` 와 ~~~ -->')).toBe(true);
  });
  it('코드 노드는 내용이 주석 모양이어도 보이는 것 — false(렌더러와 같은 파서)', () => {
    expect(isCommentOnlyContent('    <!-- indented -->')).toBe(false);
    expect(isCommentOnlyContent('```\n<!-- x -->\n```')).toBe(false);
    expect(isCommentOnlyContent('<!-- a -->\n    <!-- literal -->')).toBe(false);
    expect(isCommentOnlyContent('<!-- a -->\n\n    <!-- literal -->')).toBe(false);
  });
  it('주석 여러 개·안 닫힌 주석·빈 줄 섞여도 주석뿐이면 true', () => {
    expect(isCommentOnlyContent('<!-- a -->\n\n<!-- b -->\n')).toBe(true);
    expect(isCommentOnlyContent('  <!-- a -->  ')).toBe(true);
  });
});
