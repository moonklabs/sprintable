import { describe, expect, it } from 'vitest';
import { isImeComposing } from './ime-composition';

describe('isImeComposing — 입력기 조합 중인 키 입력', () => {
  it('네이티브 이벤트: isComposing true면 조합 중', () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });
  it('React 합성 이벤트: nativeEvent.isComposing true면 조합 중', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
  });
  it('keyCode 229(조합 중 키의 옛 표지)면 isComposing이 false여도 조합 중', () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });
  it('조합이 아닌 보통 엔터 · 에스케이프는 조합 중이 아니다', () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 27 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });
  it('이벤트가 없어도 터지지 않는다', () => {
    expect(isImeComposing(undefined)).toBe(false);
    expect(isImeComposing(null)).toBe(false);
  });
});
