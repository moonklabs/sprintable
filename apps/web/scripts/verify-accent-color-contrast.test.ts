import { describe, expect, it } from 'vitest';
import { readGlobalsCss } from './lib/read-globals-css';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAccentColorContrasts } from './verify-accent-color-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');

function fixture(primary: string, background: string, card: string): string {
  return `:root {\n  --primary: ${primary};\n  --background: ${background};\n  --card: ${card};\n}\n.dark {\n  --primary: ${primary};\n  --background: ${background};\n  --card: ${card};\n}\n`;
}

describe('computeAccentColorContrasts (story #4128 — accent-color 회귀 대비 가드)', () => {
  it('실 globals.css의 토큰으로 실측값을 재현한다(story 4919 — --primary=ds-action: 라이트 5.45/다크 5.84 배경, 라이트 5.95/다크 3.17 흰 체크 · 옛 유나 정본 6.02/6.09 · 6.51/3.21)', () => {
    const css = readGlobalsCss(GLOBALS_CSS_PATH);
    const results = computeAccentColorContrasts(css);
    const light = results.find((r) => r.theme === 'light')!;
    const dark = results.find((r) => r.theme === 'dark')!;

    expect(light.fillOnBackgroundRatio).toBeCloseTo(5.45, 1);
    expect(light.whiteCheckOnFillRatio).toBeCloseTo(5.95, 1);
    expect(dark.fillOnBackgroundRatio).toBeCloseTo(5.84, 1);
    expect(dark.whiteCheckOnFillRatio).toBeCloseTo(3.17, 1);

    for (const r of results) {
      expect(r.fillOnBackgroundRatio, `${r.theme} 채움 vs 배경`).toBeGreaterThanOrEqual(3);
      expect(r.fillOnCardRatio, `${r.theme} 채움 vs 카드`).toBeGreaterThanOrEqual(3);
      expect(r.whiteCheckOnFillRatio, `${r.theme} 흰 체크 vs 채움`).toBeGreaterThanOrEqual(3);
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

  it('⭐양성대조 — 흰 체크와 거의 같은 밝기의 채움이면 whiteCheckOnFillRatio가 3:1 미만이다', () => {
    const css = fixture('oklch(0.95 0.02 250)', 'oklch(0.3 0.02 250)', 'oklch(0.35 0.02 250)');
    const results = computeAccentColorContrasts(css);
    for (const r of results) {
      expect(r.whiteCheckOnFillRatio).toBeLessThan(3);
    }
  });

  it('--primary가 정의되지 않은 블록이면 에러를 던진다("정의 시점에 못 재면 없는 것과 같다" 규율)', () => {
    const css = `:root {\n  --background: oklch(0.98 0.01 250);\n  --card: oklch(0.98 0.01 250);\n}\n.dark {\n  --primary: oklch(0.6 0.1 250);\n  --background: oklch(0.2 0.01 250);\n  --card: oklch(0.25 0.01 250);\n}\n`;
    expect(() => computeAccentColorContrasts(css)).toThrow(/--primary not defined/);
  });
});
