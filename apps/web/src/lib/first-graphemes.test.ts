// story 4794 — an avatar's first letter is a whole letter as a person sees it, never half of a surrogate pair («�»).
import { describe, expect, it } from 'vitest';
import { firstGraphemes } from './first-graphemes';

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('[SID:4794] firstGraphemes', () => {
  it('ordinary names: the first one or two letters', () => {
    expect(firstGraphemes('Claude Code', 1)).toBe('C');
    expect(firstGraphemes('Claude Code', 2)).toBe('Cl');
    expect(firstGraphemes('두리', 1)).toBe('두');
    expect(firstGraphemes('ab', 5)).toBe('ab');
  });
  it('an emoji name starts with the whole emoji — a ZWJ sequence, a flag, a skin tone, a heart with its selector', () => {
    expect(firstGraphemes('\u{1F469}‍\u{1F4BB} 두리', 1)).toBe('\u{1F469}‍\u{1F4BB}');
    expect(firstGraphemes('\u{1F468}‍\u{1F469}‍\u{1F467} 가족', 1)).toBe('\u{1F468}‍\u{1F469}‍\u{1F467}');
    expect(firstGraphemes('\u{1F1F0}\u{1F1F7} 한국', 1)).toBe('\u{1F1F0}\u{1F1F7}');
    expect(firstGraphemes('\u{1F469}\u{1F3FD} A', 1)).toBe('\u{1F469}\u{1F3FD}');
    expect(firstGraphemes('❤️ love', 1)).toBe('❤️');
    expect(firstGraphemes('\u{1F600}\u{1F601}', 2)).toBe('\u{1F600}\u{1F601}');
  });
  it('a letter with its combining accent is one letter', () => {
    expect(firstGraphemes('école', 1)).toBe('é');
  });
  it('never returns half of a surrogate pair, whatever the count', () => {
    for (const name of ['\u{1F469}‍\u{1F4BB} 두리', '\u{1F600}', '\u{1F600}x', '𠮷野家', 'a\u{1F600}b']) {
      for (let n = 1; n <= 4; n++) expect(LONE_SURROGATE.test(firstGraphemes(name, n)), `${name} · ${n}`).toBe(false);
    }
  });
  it('empty text or a count below one is empty', () => {
    expect(firstGraphemes('', 1)).toBe('');
    expect(firstGraphemes('abc', 0)).toBe('');
  });
});
