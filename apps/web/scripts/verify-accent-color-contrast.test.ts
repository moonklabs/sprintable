import { describe, expect, it } from 'vitest';
import { readGlobalsCss } from './lib/read-globals-css';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAccentColorContrasts } from './verify-accent-color-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');

function fixture(primary: string, background: string, card: string, onPrimary = 'oklch(1 0 0)'): string {
  return `:root {\n  --primary: ${primary};\n  --primary-foreground: ${onPrimary};\n  --background: ${background};\n  --card: ${card};\n}\n.dark {\n  --primary: ${primary};\n  --primary-foreground: ${onPrimary};\n  --background: ${background};\n  --card: ${card};\n}\n`;
}

describe('computeAccentColorContrasts (story #4128 — accent-color 회귀 대비 가드)', () => {
  it('실 globals.css의 토큰으로 실측값을 재현한다(story 5048 T0 ① — --primary=ds-action 라이트 검정 · 다크 흰: 라이트 19.09/다크 16.67 배경, 체크(on-action) 라이트 21.00/다크 21.00 · 이전 보라 5.45/5.84 · 5.95/3.17)', () => {
    const css = readGlobalsCss(GLOBALS_CSS_PATH);
    const results = computeAccentColorContrasts(css);
    const light = results.find((r) => r.theme === 'light')!;
    const dark = results.find((r) => r.theme === 'dark')!;

    expect(light.fillOnBackgroundRatio).toBeCloseTo(19.09, 1);
    expect(light.checkOnFillRatio).toBeCloseTo(21, 1);
    expect(dark.fillOnBackgroundRatio).toBeCloseTo(16.67, 1);
    expect(dark.checkOnFillRatio).toBeCloseTo(21, 1);

    for (const r of results) {
      expect(r.fillOnBackgroundRatio, `${r.theme} 채움 vs 배경`).toBeGreaterThanOrEqual(3);
      expect(r.fillOnCardRatio, `${r.theme} 채움 vs 카드`).toBeGreaterThanOrEqual(3);
      expect(r.checkOnFillRatio, `${r.theme} 체크(on-action) vs 채움`).toBeGreaterThanOrEqual(3);
    }
  });

  it('⭐양성대조 — 채움을 배경과 거의 같은 값으로 바꾸면 채움 vs 배경이 3:1 미만으로 떨어진다', () => {
    // oklch(0.98 0.01 250) ≈ 거의 흰색에 가까운 밝은 배경, 채움도 같은 값으로 맞춰 자기-대조에 가깝게 만든다.
    const css = fixture('oklch(0.97 0.01 250)', 'oklch(0.98 0.005 250)', 'oklch(0.98 0.005 250)');
    const results = computeAccentColorContrasts(css);
    for (const r of results) {
      expect(r.fillOnBackgroundRatio).toBeLessThan(3);
    }
  });

  it('⭐양성대조 — 체크 색(on-action)이 채움과 거의 같은 밝기이면 checkOnFillRatio가 3:1 미만이다(다크에서 주 행동색을 흰으로 바꾸고 on-action을 안 바꾼 사고)', () => {
    const css = fixture('oklch(0.95 0.02 250)', 'oklch(0.3 0.02 250)', 'oklch(0.35 0.02 250)', 'oklch(0.98 0 0)');
    const results = computeAccentColorContrasts(css);
    for (const r of results) {
      expect(r.checkOnFillRatio).toBeLessThan(3);
    }
  });

  it('--primary가 정의되지 않은 블록이면 에러를 던진다("정의 시점에 못 재면 없는 것과 같다" 규율)', () => {
    const css = `:root {\n  --background: oklch(0.98 0.01 250);\n  --card: oklch(0.98 0.01 250);\n}\n.dark {\n  --primary: oklch(0.6 0.1 250);\n  --background: oklch(0.2 0.01 250);\n  --card: oklch(0.25 0.01 250);\n}\n`;
    expect(() => computeAccentColorContrasts(css)).toThrow(/--primary not defined/);
  });
});
