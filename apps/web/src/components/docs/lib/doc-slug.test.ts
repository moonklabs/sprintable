import { describe, it, expect } from 'vitest';
import { slugifyDocTitle, isUntitledSlug, DOC_SLUG_MAX_LENGTH } from './doc-slug';

/**
 * Canonical FE/BE parity fixtures. The BE pytest asserts the SAME input→expected
 * pairs against its slugify so the two implementations cannot drift.
 * (Mirror of the locked spec, PO/Design confirmed 2026-06-10.)
 */
const SLUGIFY_FIXTURES: ReadonlyArray<readonly [input: string, expected: string]> = [
  ['Q3 Roadmap', 'q3-roadmap'],
  ['Hello   World', 'hello-world'],
  ['a---b', 'a-b'],
  ['  -hi-  ', 'hi'],
  ['회의록 2분기', '회의록-2분기'],
  ['한글 Title 2024', '한글-title-2024'],
  ['Hello, World! (draft)', 'hello-world-draft'],
  ['foo_bar', 'foobar'], // '_' is dropped — not \p{L}/\p{N}
  ['Café Señor', 'café-señor'], // accented Latin preserved + lowercased
  ['日本語ノート', '日本語ノート'], // CJK/kana preserved
  ['🎉🎊', ''], // emoji only → empty (caller keeps untitled-<ts>)
  ['!!!', ''],
  ['   ', ''],
];

describe('slugifyDocTitle — parity fixtures', () => {
  it.each(SLUGIFY_FIXTURES)('slugify(%j) === %j', (input, expected) => {
    expect(slugifyDocTitle(input)).toBe(expected);
  });

  it('NFC-normalizes: decomposed (NFD) 한글 yields the same slug as composed', () => {
    const composed = '회의록';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed); // sanity: inputs differ at code-point level
    expect(slugifyDocTitle(decomposed)).toBe(slugifyDocTitle(composed));
    expect(slugifyDocTitle(decomposed)).toBe('회의록');
  });

  it(`caps length at ${DOC_SLUG_MAX_LENGTH} characters`, () => {
    expect(slugifyDocTitle('a'.repeat(250))).toBe('a'.repeat(DOC_SLUG_MAX_LENGTH));
  });

  it('never leaves a trailing hyphen after the length cap', () => {
    // 'a'*199 + space + 'bbb' → '...-bbb'; slice(0,200) lands on the hyphen
    const out = slugifyDocTitle(`${'a'.repeat(199)} bbb`);
    expect(out.endsWith('-')).toBe(false);
    expect(out).toBe('a'.repeat(199));
  });
});

describe('isUntitledSlug', () => {
  it('matches the auto-generated untitled-<timestamp> placeholder', () => {
    expect(isUntitledSlug('untitled-1780983794848')).toBe(true);
  });

  it('rejects real slugs and near-misses', () => {
    expect(isUntitledSlug('q3-roadmap')).toBe(false);
    expect(isUntitledSlug('untitled')).toBe(false);
    expect(isUntitledSlug('untitled-roadmap')).toBe(false);
    expect(isUntitledSlug('my-untitled-123')).toBe(false);
    expect(isUntitledSlug('회의록')).toBe(false);
  });
});
