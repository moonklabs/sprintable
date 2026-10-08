// story 4633 (PO web part): hiddenCharsChange — true exactly when the v0.4 instruction filter would change the text
import { describe, expect, it } from 'vitest';
import { hiddenCharsChange } from './instruction-text';

const c = (n: number) => String.fromCodePoint(n);

describe('[4633] hiddenCharsChange: the same check the daemon runs on a signed instruction', () => {
  it('plain text, a family emoji and a Persian non-joiner are not changed', () => {
    expect(hiddenCharsChange('빌드 결과를 정리해서 남겨 주세요')).toBe(false);
    expect(hiddenCharsChange(`${c(0x1f468)}${c(0x200d)}${c(0x1f469)}${c(0x200d)}${c(0x1f467)}`)).toBe(false);
    expect(hiddenCharsChange(`${c(0x645)}${c(0x6cc)}${c(0x200c)}${c(0x62e)}`)).toBe(false);
    expect(hiddenCharsChange(`${c(0x2800)} braille blank stays`)).toBe(false);
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
  it('a control character that the filter spaces counts as changed (CR is folded to LF first, so a lone CR is changed)', () => {
    expect(hiddenCharsChange('a\u0007b')).toBe(true);
    expect(hiddenCharsChange('a\nb')).toBe(false);
  });
});
