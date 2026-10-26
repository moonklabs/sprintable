// story 4794 — an avatar's first letter is a whole letter as a person sees it, never half of a surrogate pair («�»).
import { describe, expect, it, vi } from 'vitest';
import { firstGraphemes, graphemesWithin } from './first-graphemes';

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

describe('[SID:4794] without Intl.Segmenter (an old browser · a server without ICU) the code points are the fallback — still never half of a pair', () => {
  it('the module imported again with the segmenter removed', async () => {
    vi.resetModules();
    const real = Intl.Segmenter;
    const setSegmenter = (value: unknown) => Object.defineProperty(Intl, 'Segmenter', { value, configurable: true, writable: true });
    setSegmenter(undefined); // the fallback is the point of this test
    try {
      const fb = await import('./first-graphemes');
      expect(fb.firstGraphemes('Claude Code', 2)).toBe('Cl');
      for (const name of ['\u{1F469}‍\u{1F4BB} 두리', '\u{1F600}', '\u{1F600}x', '𠮷野家', 'a\u{1F600}b']) {
        for (let n = 1; n <= 4; n++) expect(LONE_SURROGATE.test(fb.firstGraphemes(name, n)), `${name} · ${n}`).toBe(false);
      }
      expect(fb.firstGraphemes('\u{1F600}\u{1F601}', 1)).toBe('\u{1F600}'); // one code point, whole
      expect(fb.firstGraphemes('\u{1F469}\u200D\u{1F4BB}', 1)).toBe('\u{1F469}'); // the fallback is code points: it cuts a ZWJ sequence to its first code point (whole, but not the sequence) — the segmenter would keep all three
      expect(firstGraphemes('\u{1F469}\u200D\u{1F4BB}', 1)).toBe('\u{1F469}\u200D\u{1F4BB}'); // …and with the segmenter present the same text is one letter: this is how the two are told apart
      expect(LONE_SURROGATE.test(fb.graphemesWithin('\u{1F600}'.repeat(40), 5))).toBe(false);
      expect(Array.from(fb.graphemesWithin('\u{1F600}'.repeat(40), 5))).toHaveLength(5);
    } finally {
      setSegmenter(real);
      vi.resetModules();
    }
  });
});

describe('[SID:4794] graphemesWithin — a cut for a name the server counts in code points', () => {
  it('short text is whole; a plain name is cut at the count', () => {
    expect(graphemesWithin('abc', 60)).toBe('abc');
    expect(graphemesWithin('a'.repeat(70), 60)).toBe('a'.repeat(60));
    expect(graphemesWithin('', 5)).toBe('');
    expect(graphemesWithin('abc', 0)).toBe('');
  });
  it('never leaves half of a surrogate pair — 59 letters then an emoji (a UTF-16 cut at 60 splits it)', () => {
    const name = `${'a'.repeat(59)}\u{1F600}`;
    expect(name.slice(0, 60)).not.toBe(graphemesWithin(name, 60)); // the old cut: 59 + half of the emoji
    expect(LONE_SURROGATE.test(name.slice(0, 60))).toBe(true);
    expect(graphemesWithin(name, 60)).toBe(name); // 60 code points: it fits whole
    expect(graphemesWithin(`${'a'.repeat(60)}\u{1F600}`, 60)).toBe('a'.repeat(60));
  });
  it('never runs past the server\'s count — a ZWJ family is 5 code points (one grapheme): it stays whole or is left out, never cut inside', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 5 code points
    expect(graphemesWithin(family.repeat(20), 60)).toBe(family.repeat(12)); // 60 code points = 12 families
    expect(graphemesWithin(`${'a'.repeat(58)}${family}`, 60)).toBe('a'.repeat(58)); // 58 + 5 > 60: the family does not fit whole → left out
    expect(graphemesWithin(family, 3)).toBe('');
    expect(Array.from(graphemesWithin(family.repeat(20), 60)).length).toBeLessThanOrEqual(60);
  });
  it('is always a START of the text (a prefix): a grapheme that does not fit ends the cut — the smaller letters after it are not picked up (Kadir lens: break → continue)', () => {
    const family4 = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'; // 7 code points, one letter
    expect(graphemesWithin(`${family4}a`, 5)).toBe(''); // the family does not fit in 5, so nothing is taken — never «a»
    expect(graphemesWithin(`${family4}ab`, 5)).toBe('');
    expect(graphemesWithin(`${family4}a`, 7)).toBe(family4); // exactly the family
    expect(graphemesWithin(`${family4}a`, 8)).toBe(`${family4}a`);
    expect(graphemesWithin(`ab${family4}cd`, 5)).toBe('ab'); // 2 fit, the family (7) stops the cut, «cd» is not taken
    for (const text of [`${family4}a`, `ab${family4}cd`, `a${family4}`, `\u{1F600}x${family4}y`, `${'z'.repeat(10)}${family4}`]) {
      for (let n = 0; n <= 14; n++) expect(text.startsWith(graphemesWithin(text, n)), `${text} · ${n}`).toBe(true);
    }
  });
});
