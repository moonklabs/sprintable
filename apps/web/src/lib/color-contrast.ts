/**
 * WCAG 상대휘도/대비비 — sRGB 0-255 채널 입력. story #2419.
 *
 * ⛔getComputedStyle(...).backgroundColor를 정규식으로 파싱해 oklch 좌표를 rgb로 착각하는
 * 실수(유나가 실제로 한 번 했다)를 피하려고, 이 모듈은 색공간 변환을 하지 않는다 — 입력은
 * 항상 실 브라우저 canvas 2d(fillStyle+getImageData)로 이미 sRGB로 환산된 픽셀이어야 한다.
 * (color-contrast.test.ts의 고정값들이 그렇게 캡처됐다.)
 */
export function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const linearize = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [linearize(r), linearize(g), linearize(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(
  rgbA: readonly [number, number, number],
  rgbB: readonly [number, number, number],
): number {
  const lA = relativeLuminance(rgbA);
  const lB = relativeLuminance(rgbB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}
