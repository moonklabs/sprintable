import { describe, expect, it } from 'vitest';
import { findUnexemptedAlphaLines } from './verify-no-muted-foreground-alpha';

describe('findUnexemptedAlphaLines (story #2611 regression guard)', () => {
  it('flags text-muted-foreground/60', () => {
    expect(findUnexemptedAlphaLines('<p className="text-xs text-muted-foreground/60">x</p>')).toEqual([1]);
  });

  it('flags an icon usage the same as text (유나 확定: 아이콘도 같은 규칙)', () => {
    expect(findUnexemptedAlphaLines('<ArrowRight className="size-3 text-muted-foreground/40" />')).toEqual([1]);
  });

  it('flags every alpha level (/40–/80)', () => {
    for (const alpha of [40, 50, 60, 70, 80]) {
      expect(findUnexemptedAlphaLines(`<p className="text-muted-foreground/${alpha}" />`)).toEqual([1]);
    }
  });

  it('flags a hover-prefixed alpha variant too', () => {
    expect(findUnexemptedAlphaLines('<p className="text-foreground hover:text-muted-foreground/70" />')).toEqual([1]);
  });

  it('reports the correct line number in a multi-line file', () => {
    const content = ['const a = 1;', '<p className="text-muted-foreground/60">x</p>', 'const b = 2;'].join('\n');
    expect(findUnexemptedAlphaLines(content)).toEqual([2]);
  });

  it('does not flag solid text-muted-foreground (already migrated)', () => {
    expect(findUnexemptedAlphaLines('<p className="text-muted-foreground">x</p>')).toEqual([]);
  });

  it('does not flag an unrelated alpha token (border-border/50)', () => {
    expect(findUnexemptedAlphaLines('<div className="border-border/50" />')).toEqual([]);
  });

  it('allows an exception with a same-line muted-alpha-ok comment', () => {
    const line = '<div className="text-muted-foreground/40" /> {/* muted-alpha-ok: 배경 워터마크·aria-hidden·인접 텍스트 없음 */}';
    expect(findUnexemptedAlphaLines(line)).toEqual([]);
  });

  it('allows an exception with a muted-alpha-ok comment on the previous line', () => {
    const content = [
      '{/* muted-alpha-ok: 큰 배경 워터마크, aria-hidden, 인접 텍스트 없음 */}',
      '<div className="text-muted-foreground/40" />',
    ].join('\n');
    expect(findUnexemptedAlphaLines(content)).toEqual([]);
  });

  it('does not treat a bare "muted-alpha-ok" with no reason as a valid valve', () => {
    const line = '<div className="text-muted-foreground/40" /> {/* muted-alpha-ok */}';
    expect(findUnexemptedAlphaLines(line)).toEqual([1]);
  });
});
