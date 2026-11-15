import { describe, it, expect, vi } from 'vitest';
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

// 4910 ② — 임시 슬러그(서버에 아직 없는 초안의 주소): 같은 순간 두 사람이 «새 문서»를 눌러도 같은 주소가 되지 않는다.
describe('newUntitledSlug (4910)', () => {
  it('`untitled-<시각><여섯 자리 무작위 수>` — 숫자뿐이라 isUntitledSlug가 그대로 받는다(제목에서 슬러그 파생 · URL 안내가 계속 동작)', async () => {
    const { newUntitledSlug, isUntitledSlug } = await import('./doc-slug');
    const slug = newUntitledSlug(1_700_000_000_000);
    expect(slug).toMatch(/^untitled-1700000000000\d{6}$/);
    expect(isUntitledSlug(slug)).toBe(true);
  });

  it('⭐같은 시각(같은 밀리초)에 만들어도 꼬리는 무작위 수에서 온다 — 무작위 수가 다르면 슬러그가 다르다(꼬리를 떼면 200개가 전부 같아진다 · 결정적)', async () => {
    const { newUntitledSlug } = await import('./doc-slug');
    let n = 0;
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint32Array) => { buf[0] = 1000 + n++; return buf; }) as typeof crypto.getRandomValues);
    try {
      const slugs = Array.from({ length: 200 }, () => newUntitledSlug(1_700_000_000_000));
      expect(new Set(slugs).size).toBe(200);
      expect(slugs[0]).toBe('untitled-1700000000000001000');
    } finally { spy.mockRestore(); }
  });

  it('인자 없이 부르면 지금 시각을 쓴다', async () => {
    const { newUntitledSlug } = await import('./doc-slug');
    const before = Date.now();
    const slug = newUntitledSlug();
    const stamp = Number(slug.slice('untitled-'.length, 'untitled-'.length + 13));
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });
});
