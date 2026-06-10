import { describe, it, expect } from 'vitest';
import { slugifyDocTitle, isUntitledSlug } from './doc-slug';

describe('slugifyDocTitle', () => {
  it('lowercases and hyphenates whitespace', () => {
    expect(slugifyDocTitle('Q3 Roadmap')).toBe('q3-roadmap');
  });

  it('collapses repeated whitespace and hyphens', () => {
    expect(slugifyDocTitle('Hello   World')).toBe('hello-world');
    expect(slugifyDocTitle('a---b')).toBe('a-b');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugifyDocTitle('  -hi-  ')).toBe('hi');
  });

  it('preserves Korean syllables', () => {
    expect(slugifyDocTitle('회의록 2분기')).toBe('회의록-2분기');
  });

  it('drops punctuation and symbols', () => {
    expect(slugifyDocTitle('Hello, World! (draft)')).toBe('hello-world-draft');
  });

  it('returns empty string when no slug-able characters remain', () => {
    expect(slugifyDocTitle('!!!')).toBe('');
    expect(slugifyDocTitle('   ')).toBe('');
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
  });
});
