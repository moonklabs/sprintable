import { describe, expect, it } from 'vitest';
import { contrastRatio, relativeLuminance } from './color-contrast';

/**
 * story #2419 — 픽셀 fixture는 실 Chromium canvas 2d(fillStyle+getImageData)로 캡처했다
 * (2026-08-02, Puppeteer). ⛔jsdom의 canvas stub은 실 렌더를 안 하므로 여기서 색공간 변환을
 * 재현하지 않는다 — 이미 sRGB로 환산된 실측 RGB를 고정값으로 쓴다.
 *
 * 캡처 방법(유나 규격 그대로):
 *   부모 배경을 먼저 fillRect → 그 위에 `color-mix(in oklab, <색> N%, transparent)`를
 *   덮어 fillRect → getImageData로 실제 합성된 픽셀을 읽는다.
 */
const WHITE = [255, 255, 255] as const;
const BLACK = [0, 0, 0] as const;
const LIGHT_PAGE_BG = [255, 255, 255] as const; // --background(light) = oklch(1 0 0)
const LIGHT_BOX_BG = [252, 229, 230] as const; // bg-destructive/10 위 white
const LIGHT_TEXT_OLD = [231, 0, 11] as const; // --destructive(light) = oklch(0.577 .245 27.325)
const LIGHT_TEXT_NEW = [202, 0, 0] as const; // --destructive-on-subtle = oklch(0.50 .245 27.325)
const DARK_PAGE_BG = [17, 17, 20] as const; // --background(dark)
const DARK_BOX_BG = [41, 25, 28] as const; // bg-destructive/10(dark) 위 dark bg
const DARK_TEXT = [255, 100, 103] as const; // --destructive(dark) = oklch(0.704 .191 22.216) — 무변경

describe('contrastRatio — story #2419 (destructive-on-subtle 대비 확保)', () => {
  it('양성대조 — 흰↔검은 21이어야 한다(자가 도는지 확認)', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 1);
  });

  it('light: 기존 --destructive 텍스트는 옅은 박스 위에서 AA(4.5) 미달이었다(3.97, 유나 실측과 일치)', () => {
    expect(contrastRatio(LIGHT_TEXT_OLD, LIGHT_BOX_BG)).toBeCloseTo(3.97, 1);
    expect(contrastRatio(LIGHT_TEXT_OLD, LIGHT_BOX_BG)).toBeLessThan(4.5);
  });

  it('light: --destructive-on-subtle은 같은 박스 위에서 AA를 통과한다(약 4.98)', () => {
    const ratio = contrastRatio(LIGHT_TEXT_NEW, LIGHT_BOX_BG);
    expect(ratio).toBeCloseTo(4.98, 1);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('dark: 기존 --destructive는 박스 위에서 이미 AA를 통과하므로 손대지 않는다(5.82, 유나 실측과 일치)', () => {
    const ratio = contrastRatio(DARK_TEXT, DARK_BOX_BG);
    expect(ratio).toBeCloseTo(5.82, 1);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('회귀 가드 — light 텍스트/박스/페이지 색이 이 값 그대로일 때만 위 판정이 유효하다(값이 바뀌면 재실측 필요)', () => {
    expect(relativeLuminance(LIGHT_PAGE_BG)).toBeCloseTo(1, 2);
    expect(relativeLuminance(DARK_PAGE_BG)).toBeLessThan(0.05);
  });
});
