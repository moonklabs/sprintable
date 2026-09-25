import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBrandTextContrasts, findBrandSoftTextUses, scanRepo } from './verify-brand-text-contrast';

const CSS = readFileSync(path.resolve(__dirname, '../src/app/globals.css'), 'utf8');

describe('story #4315 — 브랜드 글자 토큰 대비', () => {
  it('⭐양 테마 --brand-text가 배경 · 카드 · 칩 틴트에서 4.5:1 이상(기대값 pin)', () => {
    const [light, dark] = computeBrandTextContrasts(CSS);
    expect(light!.onBackground).toBeCloseTo(7.05, 1);
    expect(dark!.onBackground).toBeCloseTo(10.48, 1);
    for (const c of [light!, dark!]) {
      expect(c.onBackground).toBeGreaterThanOrEqual(4.5);
      expect(c.onCard).toBeGreaterThanOrEqual(4.5);
      expect(c.onChipTint).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('양성대조 — 밝은 테마 글자가 brand-soft였다면 1.25로 FAIL(예전 모양)', () => {
    const regressed = CSS.replace('--brand-text: var(--brand-strong);', '--brand-text: var(--brand-soft);');
    expect(regressed).not.toBe(CSS);
    const [light] = computeBrandTextContrasts(regressed);
    expect(light!.onBackground).toBeCloseTo(1.25, 1);
    expect(light!.onBackground).toBeLessThan(4.5);
  });

  it('양성대조 — 어두운 테마를 brand-strong으로 바꾸면(3.92) FAIL — 테마마다 다른 토큰이어야 한다', () => {
    const regressed = CSS.replace('--brand-text: var(--brand-soft);', '--brand-text: var(--brand-strong);');
    expect(regressed).not.toBe(CSS);
    const [, dark] = computeBrandTextContrasts(regressed);
    expect(dark!.onBackground).toBeLessThan(4.5);
  });
});

describe('story #4315 — brand-soft 글자색 사용처', () => {
  const count = (src: string, file = 'x.tsx') => findBrandSoftTextUses(src, file).length;

  it('양성 — 글자색 모양 셋(유틸 · 임의값 · 변형 사슬 · CSS)', () => {
    expect(count("<a className=\"text-brand-soft underline\" />")).toBe(1);
    expect(count("const c = 'bg-brand/14 text-[color:var(--brand-soft)]';")).toBe(1);
    expect(count("'[&_a]:text-brand-soft [&_a]:underline'")).toBe(1);
    expect(count("<span className=\"hover:text-brand-soft\" />")).toBe(1);
    expect(count('.link { color: var(--brand-soft); }', 'x.css')).toBe(1);
  });

  it('음성 — 틴트(bg · border) · dark: 전용 · 새 토큰 · 이름만 비슷한 것', () => {
    expect(count("<div className=\"bg-brand-soft border-brand-soft\" />")).toBe(0);
    expect(count("<a className=\"text-brand-text dark:text-brand-soft\" />")).toBe(0);
    expect(count("<a className=\"text-brand-text\" />")).toBe(0);
    expect(count("<a className=\"text-brand-soft-x\" />")).toBe(0);
    expect(count('.chip { background-color: var(--brand-soft); }', 'x.css')).toBe(0);
  });

  it('⭐실 저장소 — brand-soft 글자색 0(dark: 전용 제외)', () => {
    expect(scanRepo(path.resolve(__dirname, '../src'))).toEqual([]);
  });
});
