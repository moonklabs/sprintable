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
  it('코드 표지가 있으면 판정하지 않는다(false) — 코드 안 주석을 빈 본문으로 오판하지 않게', () => {
    expect(isCommentOnlyContent('    <!-- indented -->')).toBe(false);
    expect(isCommentOnlyContent('```\n<!-- x -->\n```')).toBe(false);
  });
});
