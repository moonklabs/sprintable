import { describe, expect, it } from 'vitest';
import { parseOklch, oklchToSrgb255, parseOklchToRgba, compositeOver } from './oklch-contrast';
import { contrastRatio } from './color-contrast';

/**
 * story #2420 AC3 — 이 모듈의 변환이 «맞는지»는 color-contrast.test.ts(story #2419)가 실
 * Chromium canvas 2d로 캡처한 값과 «독립적으로» 대조해서 증명한다. 같은 원본 oklch 값을
 * 손으로 짠 수학으로 변환했을 때 실측과 같은 숫자가 나오면, 이 구현은 "그럴듯한 공식"이
 * 아니라 "실제로 브라우저와 같은 답을 내는 변환"이다.
 */
describe('parseOklch', () => {
  it('parses "L C H" without alpha', () => {
    expect(parseOklch('oklch(0.577 0.245 27.325)')).toEqual({ l: 0.577, c: 0.245, h: 27.325, alpha: 1 });
  });

  it('parses "L C H / A%" with percent alpha', () => {
    expect(parseOklch('oklch(0.577 0.245 27.325 / 10%)')).toEqual({ l: 0.577, c: 0.245, h: 27.325, alpha: 0.1 });
  });

  it('returns null for non-oklch input', () => {
    expect(parseOklch('rgb(255 0 0)')).toBeNull();
    expect(parseOklch('var(--destructive)')).toBeNull();
  });
});

describe('oklchToSrgb255 — cross-checked against real Chromium canvas captures (color-contrast.test.ts fixtures)', () => {
  it('story #2419 v2 fixture(퇴역한 계열별 토큰 값) light: oklch(0.50 .245 27.325) → [202,0,0] (실측 그대로)', () => {
    expect(oklchToSrgb255(0.5, 0.245, 27.325)).toEqual([202, 0, 0]);
  });

  it('destructive light text: oklch(0.577 .245 27.325) → [231,0,11] (실측 그대로)', () => {
    expect(oklchToSrgb255(0.577, 0.245, 27.325)).toEqual([231, 0, 11]);
  });

  it('background light: oklch(1 0 0) → [255,255,255]', () => {
    expect(oklchToSrgb255(1, 0, 0)).toEqual([255, 255, 255]);
  });

  it('background dark: oklch(0.18 .005 285.823) → [17,17,20] (실측 그대로)', () => {
    expect(oklchToSrgb255(0.18, 0.005, 285.823)).toEqual([17, 17, 20]);
  });

  it('destructive dark text: oklch(0.704 .191 22.216) → [255,100,103] (실측 그대로)', () => {
    expect(oklchToSrgb255(0.704, 0.191, 22.216)).toEqual([255, 100, 103]);
  });
});

describe('compositeOver — alpha 합성, 실측과 대조', () => {
  it('dark destructive-tint(10%) over dark bg → [41,25,28] (bit-exact 실측)', () => {
    const fg = parseOklchToRgba('oklch(0.704 0.191 22.216 / 10%)')!;
    expect(compositeOver(fg, [17, 17, 20])).toEqual([41, 25, 28]);
  });

  it('light destructive-tint(10%) over white → 실측 [252,229,230]과 채널당 ±1 이내(측정 노이즈 크기, 대비비 판정엔 무관)', () => {
    const fg = parseOklchToRgba('oklch(0.577 0.245 27.325 / 10%)')!;
    const [r, g, b] = compositeOver(fg, [255, 255, 255]);
    expect(Math.abs(r - 252)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 229)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 230)).toBeLessThanOrEqual(1);
  });

  it('end-to-end: on-subtle 글자 vs light tint 배경 대비 ≈ 4.98(color-contrast.test.ts와 동일 판정)', () => {
    const textRgb = oklchToSrgb255(0.5, 0.245, 27.325);
    const tintFg = parseOklchToRgba('oklch(0.577 0.245 27.325 / 10%)')!;
    const bgRgb = compositeOver(tintFg, [255, 255, 255]);
    const ratio = contrastRatio(textRgb, bgRgb);
    expect(ratio).toBeCloseTo(4.98, 1);
  });
});
