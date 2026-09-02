import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSubtleAlpha, scanContent, scanRepo, CLOSED_FAMILIES } from './verify-no-subtle-alpha-bg';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('findSubtleAlpha (story #2420 AC4/AC6)', () => {
  it('flags a closed-family subtle alpha bg (rest and state-prefixed)', () => {
    expect(findSubtleAlpha('rounded-md bg-destructive/10 text-foreground')).toEqual([
      { family: 'destructive', token: 'bg-destructive/10' },
    ]);
    expect(findSubtleAlpha('text-foreground hover:bg-destructive/20').map((h) => h.token)).toEqual([
      'bg-destructive/20',
    ]);
  });

  it('flags every subtle step (5/8/10/15/20/30)', () => {
    for (const n of [5, 8, 10, 15, 20, 30]) {
      expect(findSubtleAlpha(`bg-destructive/${n}`).length, `n=${n}`).toBe(1);
    }
  });

  it('does NOT flag dark backgrounds /80 /90 (n>=50, out of scope)', () => {
    expect(findSubtleAlpha('hover:bg-destructive/80')).toEqual([]);
    expect(findSubtleAlpha('hover:bg-destructive/90')).toEqual([]);
  });

  it('does NOT flag the opaque token bg-destructive-tint (the canonical target)', () => {
    expect(findSubtleAlpha('border-destructive-border bg-destructive-tint text-foreground')).toEqual([]);
  });

  it('does NOT flag non-bg alpha (border/ring keep their alpha — different axis)', () => {
    expect(findSubtleAlpha('border border-destructive/40 ring-destructive/20')).toEqual([]);
  });

  it('does NOT flag families not yet closed (warning/info/success still have live alpha)', () => {
    expect(CLOSED_FAMILIES).toEqual(['destructive']);
    expect(findSubtleAlpha('bg-warning/10 bg-info/15 bg-success/8')).toEqual([]);
  });
});

describe('scanContent — AST literal extraction only (story #2710 lesson)', () => {
  it('flags a subtle alpha inside a real string literal', () => {
    const v = scanContent('export const c = "rounded bg-destructive/10 text-foreground";', 'x.tsx');
    expect(v.map((h) => h.token)).toEqual(['bg-destructive/10']);
  });

  it('does NOT flag a subtle alpha that lives only in a comment', () => {
    // 주석 속 역사 서술(bg-destructive/10 위 text-destructive는 3.97)은 리터럴이 아니다.
    const v = scanContent('// story #2419 — bg-destructive/10 위 text-destructive는 3.97\nconst x = 1;', 'x.tsx');
    expect(v).toEqual([]);
  });

  // AC6 양성대조 — 가드가 실패할 수 있어야 한다: 한 자리를 알파로 되돌리면 빨간불.
  it('AC6 positive control: reverting one site to bg-destructive/10 is caught', () => {
    const reverted = 'export const cls = "flex items-center bg-destructive/10 text-foreground";';
    expect(scanContent(reverted, 'reverted.tsx').length).toBe(1);
  });
});

describe('repo state (story #2420 destructive pilot)', () => {
  it('has zero closed-family subtle alpha bg across src (destructive fully migrated to bg-destructive-tint)', () => {
    expect(scanRepo(SRC_ROOT)).toEqual([]);
  });
});
