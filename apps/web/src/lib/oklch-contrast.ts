/**
 * story #2420 AC3 — 토큰 «정의 시점» 대비 검사를 브라우저 없이 돌리기 위한 oklch→sRGB 변환.
 *
 * ⛔color-contrast.ts(story #2419)의 경고를 그대로 지킨다 — "getComputedStyle(...)의 oklch(...)
 * «문자열»을 정규식으로 파싱해 좌표를 rgb로 착각"하지 않는다. 이 모듈은 그 실수가 아니라
 * «올바른» oklch→선형광→sRGB 변환(CSS Color 4 표준 행렬, Björn Ottosson OKLab 정의)을 직접
 * 구현한다 — «파싱을 틀리는 것»과 «색공간 수학을 올바르게 하는 것」은 다른 일이다.
 *
 * 검산(oklch-contrast.test.ts) — 이 구현이 맞는지는 Yuna의 실 Chromium canvas 2d 캡처값
 * (color-contrast.test.ts의 고정 픽셀들)과 «독립적으로 대조»해서 증명한다: on-subtle
 * oklch(0.50 .245 27.325)→[202,0,0], destructive-light oklch(0.577 .245 27.325)→[231,0,11],
 * dark bg·dark destructive text·dark 10% 합성까지 전부 bit-exact. light 10% 합성만 채널당
 * ±1(측정 노이즈로 판단 — 아래 참고) — 4.5 문턱 판정에 영향 없는 크기.
 *
 * ⚠️검증 범위(유나양 재실측, 2026-08-02 리뷰) — "실측과 대조해 변환이 맞다"는 무조건 참이
 * 아니다. 대조에 쓴 다섯 값의 성질을 재보면 hue는 흩어져 있지만 명도·채도가 L 0.5~0.75·
 * 중간~높은 채도라는 한 구역에 몰려 있다. 이 구현이 실제로 검증된 것은 «그 구역 안»뿐이다 —
 * 색역 밖(채도 극단)·극단 명도(L→0·1)·무채색(C=0, 색상각이 뜻을 잃는 경계)은 안 쟀다. 이
 * 레포의 실제 토큰이 전부 그 구역 안이라 지금은 문제 없지만, 새 `-tint` 계열을 극단값으로
 * 정의하는 사람이 있다면 이 함수를 다시 검증할 자리라는 것을 여기 남긴다.
 */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const OKLCH_RE = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/;

/** "oklch(L C H)" 또는 "oklch(L C H / A%)" 문자열을 파싱한다. L은 0-1 소수 표기만 지원
 * (이 레포 globals.css의 실제 표기 그대로 — 퍼센트 L은 안 씀, 필요해지면 그때 추가). */
export function parseOklch(value: string): { l: number; c: number; h: number; alpha: number } | null {
  const m = OKLCH_RE.exec(value.trim());
  if (!m) return null;
  const l = Number(m[1]!.replace('%', '')) / (m[1]!.endsWith('%') ? 100 : 1);
  const c = Number(m[2]);
  const h = Number(m[3]);
  let alpha = 1;
  if (m[4] !== undefined) {
    alpha = m[5] === '%' ? Number(m[4]) / 100 : Number(m[4]);
  }
  return { l, c, h, alpha };
}

function srgbEncode(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** OKLCH(L,C,H) → sRGB [0,255] 정수 채널. 표준 OKLab↔LMS 행렬(CSS Color 4). */
export function oklchToSrgb255(l: number, c: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;

  const rLin = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return [
    Math.round(255 * srgbEncode(rLin)),
    Math.round(255 * srgbEncode(gLin)),
    Math.round(255 * srgbEncode(bLin)),
  ];
}

/** "oklch(...)" 문자열을 sRGB+alpha로 직접 변환. */
export function parseOklchToRgba(value: string): RgbaColor | null {
  const parsed = parseOklch(value);
  if (!parsed) return null;
  const [r, g, b] = oklchToSrgb255(parsed.l, parsed.c, parsed.h);
  return { r, g, b, a: parsed.alpha };
}

/** source-over 알파 합성(단순, sRGB 감마공간에서) — fg가 반투명 배경 위에 올라간 실제
 * 렌더 픽셀을 낸다. Yuna의 canvas fillStyle 방식과 동형(먼저 배경을 칠하고 그 위를 덮는다). */
export function compositeOver(fg: RgbaColor, bg: readonly [number, number, number]): [number, number, number] {
  return [
    Math.round(fg.a * fg.r + (1 - fg.a) * bg[0]),
    Math.round(fg.a * fg.g + (1 - fg.a) * bg[1]),
    Math.round(fg.a * fg.b + (1 - fg.a) * bg[2]),
  ];
}
