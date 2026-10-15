// story 4633 (PO web part): hiddenCharsChange — true exactly when invisible format characters would be removed
import { describe, expect, it } from 'vitest';
import { hiddenCharsChange } from './instruction-text';

const c = (n: number) => String.fromCodePoint(n);

describe('[4633] hiddenCharsChange: the invisible characters the daemon removes', () => {
  it('plain text, a family emoji, a Persian non-joiner and the braille blank are not changed', () => {
    expect(hiddenCharsChange('빌드 결과를 정리해서 남겨 주세요')).toBe(false);
    expect(hiddenCharsChange(`${c(0x1f468)}${c(0x200d)}${c(0x1f469)}${c(0x200d)}${c(0x1f467)}`)).toBe(false);
    expect(hiddenCharsChange(`${c(0x645)}${c(0x6cc)}${c(0x200c)}${c(0x62e)}`)).toBe(false);
    expect(hiddenCharsChange(`${c(0x2800)} braille blank stays`)).toBe(false);
  });
  it('a tab, a CR, a LF and another control character are shown as they are — not hidden (Kadir 943fac90f)', () => {
    expect(hiddenCharsChange('a\tb')).toBe(false);
    expect(hiddenCharsChange('a\r\nb')).toBe(false);
    expect(hiddenCharsChange('a\nb')).toBe(false);
    expect(hiddenCharsChange(`a${c(0x7)}b`)).toBe(false);
  });
  it('a bidi override, a zero-width space, a tag character and a joiner between Latin letters are changed', () => {
    expect(hiddenCharsChange(`a${c(0x202e)}b`)).toBe(true);
    expect(hiddenCharsChange(`a${c(0x200b)}b`)).toBe(true);
    expect(hiddenCharsChange(`ok${c(0xe0041)}`)).toBe(true);
    expect(hiddenCharsChange(`a${c(0x200d)}b`)).toBe(true);
  });
  it('a run of variation selectors after one character is changed; one that belongs stays', () => {
    expect(hiddenCharsChange(`${c(0x2764)}${c(0xfe0f)}${c(0xfe0f)}${c(0xfe0f)}`)).toBe(true);
    expect(hiddenCharsChange(`${c(0x2764)}${c(0xfe0f)}`)).toBe(false);
  });
});
