/**
 * WCAG 상대휘도/대비비 — sRGB 0-255 채널 입력. story #2419.
 *
 * ⛔getComputedStyle(...).backgroundColor를 정규식으로 파싱해 oklch 좌표를 rgb로 착각하는
 * 실수(유나가 실제로 한 번 했다)를 피하려고, 이 모듈은 색공간 변환을 하지 않는다 — 입력은
 * 항상 실 브라우저 canvas 2d(fillStyle+getImageData)로 이미 sRGB로 환산된 픽셀이어야 한다.
 * (color-contrast.test.ts의 고정값들이 그렇게 캡처됐다.)
 *
 * ⚠️이것은 «계산기»다 — 두 색의 비만 낸다. «무엇을 재는지»(글자↔요소·요소↔배경의 두 층,
 * rest/hover/focus 등 상태별 배경, 알파 합성)는 호출자가 정한다. 이 유틸이 있다고 대비가
 * 검증되는 것은 아니다 — 그 판정은 호출자의 몫이다.
 *
 * ⛔⭐그리고 이 자는 «명도»만 잰다 — 색상(hue) 차이는 못 잰다. 그래서 「면↔배경이 구별되는가」
 * 에는 답하지 않는다. 옅은 노랑 #fbf5e5 ↔ 흰 #ffffff 은 대비비 1.09 지만 ΔE 9.09 로 실제로는
 * 구별된다(story #2420 실측). ⇒ 낮은 대비비를 보고 「안 보인다」로 읽지 말 것 — 그것은
 * 「이 자로는 못 잰다」는 뜻이고, 그 축은 ΔE(색차: 명도+색상+채도)로 잰다.
 *
 * ⚠️ΔE 도 «정상 색각» 기준이다. 색조로만 구별되는 면이 색맹에서도 서는지는 또 다른 축이며
 * story #2425 가 그것을 잰다.
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
