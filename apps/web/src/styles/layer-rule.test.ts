// UI-3(a9d56577) · 4906 — «화면 층 규칙» 회귀가드: 층 토큰의 실제 값(design-system.css · 라이트 · 다크)으로 이웃한 두 층의 밝기차(OKLab L)를 계산해 최소 크기를 지킨다.
// 토큰 값을 바꾸거나 층에 다른 토큰을 쓰면 여기가 빨개진다 — 숫자는 components/ds/layers.ts 머리표와 같다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYER, LAYER_MIN_STEP, LAYER_TOKEN } from '../components/ds/layers';

const css = readFileSync(join(__dirname, 'design-system.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selector} not found`);
  return Object.fromEntries([...m[1].matchAll(/--ds-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1], x[2].toLowerCase()]));
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** OKLab 밝기 L (0~1) — 사람 눈이 느끼는 밝기에 가깝게 고른 척도 */
function lightness(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** OKLab 채도 C — a, b 성분의 크기 */
function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

/** WCAG 대비 배율 */
function contrast(a: string, b: string): number {
  const relative = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [relative(a), relative(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes: Array<[string, Record<string, string>]> = [['라이트', block(':root')], ['다크', block('.dark')]];
const step = (t: Record<string, string>, from: keyof typeof LAYER_TOKEN, to: keyof typeof LAYER_TOKEN) => Math.abs(lightness(t[LAYER_TOKEN[to]]!) - lightness(t[LAYER_TOKEN[from]]!));

describe('화면 층 규칙 — 이웃한 층은 눈으로 갈린다', () => {
  it.each(themes)('⭐%s: 바탕 → 내용 칸 ≥ 0.03 · 내용 칸 → 남의 글 ≥ 0.05 · 내 글 ≥ 0.09 · 입력칸 ≥ 0.05', (_name, t) => {
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
    expect(step(t, 'panel', 'rowMine')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowMineOnPanel);
    expect(step(t, 'panel', 'field')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.fieldOnPanel);
  });

  it('⭐옛 문제 재현 가드: «바탕 ↔ 떠 있는 면»처럼 면 차이로 가르지 않는 쌍(0.009)이 층 표에 이웃으로 들어오지 않는다', () => {
    // 라이트에서 바탕과 떠 있는 면의 밝기차는 0.009(선생님 지적의 뿌리) — 그래서 떠 있는 것은 면이 아니라 그림자 + 경계로 가른다고 표에 적었다.
    expect(step(themes[0]![1], 'page', 'floating')).toBeLessThan(LAYER_MIN_STEP.panelOverPage);
  });

  it.each(themes)('⭐%s: 글 줄 면 위의 글자(ink · ink-2 · action-text)는 4.5:1 이상 — 새 면 위에서 옛 muted/primary 글자가 못 읽히던 사고 방지', (_name, t) => {
    for (const row of ['rowOthers', 'rowMine'] as const) {
      for (const ink of ['ink', 'ink-2', 'action-text']) expect(contrast(t[ink]!, t[LAYER_TOKEN[row]]!), `${ink} on ${row}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('층마다 토큰이 서로 다르다(같은 토큰을 두 층에 쓰지 않는다) · 클래스 이름이 토큰 이름을 가리킨다', () => {
    const tokens = Object.values(LAYER_TOKEN);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const key of Object.keys(LAYER) as Array<keyof typeof LAYER>) expect(LAYER[key]).toBe(`bg-ds-${LAYER_TOKEN[key]}`);
  });

  it.each(themes)('⭐%s: 내 글 ↔ 남의 글은 색조만이 아니라 밝기(ΔL ≥ 0.05)와 채도(ΔC ≥ 0.03) 둘 다 갈린다(연보라 ↔ 연회색 사고 11-12)', (_name, t) => {
    const mine = t[LAYER_TOKEN.rowMine]!;
    const others = t[LAYER_TOKEN.rowOthers]!;
    expect(Math.abs(lightness(mine) - lightness(others))).toBeGreaterThanOrEqual(LAYER_MIN_STEP.mineVsOthersLightness);
    expect(chroma(mine) - chroma(others)).toBeGreaterThanOrEqual(LAYER_MIN_STEP.mineVsOthersChroma);
  });
});
