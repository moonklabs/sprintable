import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMutedForegroundContrasts } from './verify-muted-foreground-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');

// story #2480 AC6과 같은 규율(#2420) — 양성대조: 이 검사가 «실패할 수 있어야» 한다.
describe('computeMutedForegroundContrasts — 양성대조: 미달 정의는 빨간불이어야 한다', () => {
  it('구 값(L 0.552, #2866이 발견한 실 미달치)은 bg-muted 위에서 FAIL로 잡힌다', () => {
    const oldCss = `
:root {
  --background: oklch(1 0 0);
  --card: oklch(1 0 0);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --card: oklch(0.21 0.006 285.885);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
}
`;
    const results = computeMutedForegroundContrasts(oldCss);
    const lightOnMuted = results.find((r) => r.theme === 'light' && r.bgVar === 'muted')!;
    expect(lightOnMuted.ratio).toBeLessThan(4.5);
  });

  it('신 값(L 0.52, story #2480 fix)은 전 조합에서 통과한다', () => {
    const fixedCss = `
:root {
  --background: oklch(1 0 0);
  --card: oklch(1 0 0);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.52 0.016 285.938);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --card: oklch(0.21 0.006 285.885);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
}
`;
    const results = computeMutedForegroundContrasts(fixedCss);
    for (const r of results) {
      expect(r.ratio, `${r.theme}/--${r.bgVar}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('real repo globals.css — story #2480: muted-foreground가 muted/background/card 전 조합에서 AA(4.5)를 통과한다', () => {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const results = computeMutedForegroundContrasts(css);

  it('checks all 6 combinations (3 backgrounds × 2 themes)', () => {
    expect(results).toHaveLength(6);
  });

  it('every background × theme combination passes 4.5 with muted-foreground', () => {
    for (const r of results) {
      expect(r.ratio, `${r.theme}/--${r.bgVar}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('light on bg-muted lands at ~5.02 (story #2480 실측치 — 회귀 시 이 값이 4.39 쪽으로 움직인다)', () => {
    const lightOnMuted = results.find((r) => r.theme === 'light' && r.bgVar === 'muted')!;
    expect(lightOnMuted.ratio).toBeCloseTo(5.02, 1);
  });
});
