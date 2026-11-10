// UI-3(a9d56577) — 새 토큰 파일 회귀가드: ① 모든 뜻 이름이 밝음(:root) · 어둠(.dark) 둘 다 정의 ② Tailwind `@theme inline` 연결 ③ 별칭 없음(옛 이름을 정의하지 않는다)
// ④ 대비 — 글자 조합 4.5:1 · 누를 수 있는 경계 3:1(상대 휘도, 이 파일의 값을 읽어 계산).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'design-system.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selector} not found`);
  return Object.fromEntries([...m[1].matchAll(/--(ds-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1], x[2].toLowerCase()]));
}
const light = block(':root');
const dark = block('.dark');

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('design-system.css — 새 뜻 이름 토큰(--ds-*)', () => {
  it('밝음 · 어둠이 같은 이름 집합을 정의한다(한쪽만 있으면 한 테마가 비어 렌더된다)', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    expect(Object.keys(light).length).toBe(27);
  });

  it('⭐고정폭 글자 하한: 가장 작은 mono-sm도 11px 이상(폰 11pt 하한 · 12px 미만 글자 처방)', () => {
    const theme = css.slice(css.indexOf('@theme inline'));
    const m = theme.match(/--text-ds-mono-sm:\s*(\d+)px;/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(11);
  });

  it('모든 뜻 이름이 @theme inline으로 Tailwind 색 `ds-*`에 이어진다', () => {
    for (const name of Object.keys(light)) {
      expect(css, name).toContain(`--color-${name}: var(--${name});`);
    }
  });

  it('글자 눈금(--text-ds-*)과 모서리(--radius-ds-*)도 @theme inline에 정의돼 있고, 글자 단마다 줄 높이가 있다', () => {
    const theme = css.slice(css.indexOf('@theme inline'));
    const sizes = [...theme.matchAll(/--text-(ds-(?:(?!--)[\w-])+):\s*\d+px;/g)].map((m) => m[1]);
    expect(sizes.sort()).toEqual(['ds-body', 'ds-card-title', 'ds-mono-lg', 'ds-mono-md', 'ds-mono-sm', 'ds-small', 'ds-title']);
    for (const n of sizes) expect(theme, n).toMatch(new RegExp(`--text-${n}--line-height:\\s*\\d+px;`));
    const radii = [...theme.matchAll(/--radius-(ds-[\w-]+):\s*\d+px;/g)].map((m) => m[1]);
    expect(radii.sort()).toEqual(['ds-control', 'ds-panel', 'ds-pill', 'ds-tag']);
  });

  it('⭐별칭 없음 — 옛 이름(--background · --foreground · --primary · --proof-* …)을 이 파일이 정의하지 않는다', () => {
    const defined = [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]);
    const legacy = defined.filter((n) => !n.startsWith('--ds-') && !n.startsWith('--color-ds-') && !n.startsWith('--text-ds-') && !n.startsWith('--radius-ds-'));
    expect(legacy).toEqual([]);
  });

  it('globals.css가 이 파일을 가져온다', () => {
    const globals = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
    expect(globals).toContain('@import "../styles/design-system.css";');
  });

  const TEXT_PAIRS: Array<[string, string]> = [
    ['ds-ink', 'ds-surface'], ['ds-ink', 'ds-background'], ['ds-ink', 'ds-surface-high'],
    ['ds-ink-2', 'ds-surface'], ['ds-ink-3', 'ds-surface'], ['ds-ink-3', 'ds-surface-sunk'], ['ds-ink-3', 'ds-surface-high'],
    ['ds-on-action', 'ds-action'], ['ds-action-text', 'ds-surface'], ['ds-action-text', 'ds-action-soft'],
    ['ds-needs-hand', 'ds-surface'], ['ds-needs-hand', 'ds-needs-hand-soft'], ['ds-on-needs-hand', 'ds-needs-hand-bar'],
    ['ds-done', 'ds-surface'], ['ds-done', 'ds-done-soft'],
    ['ds-failed', 'ds-surface'], ['ds-failed', 'ds-failed-soft'],
    ['ds-info', 'ds-surface'], ['ds-info', 'ds-info-soft'],
  ];
  for (const [mode, vars] of [['밝음', light], ['어둠', dark]] as const) {
    it(`${mode}: 글자 조합이 모두 4.5:1 이상`, () => {
      const low = TEXT_PAIRS.map(([fg, bg]) => ({ fg, bg, r: ratio(vars[fg], vars[bg]) })).filter((x) => x.r < 4.5);
      expect(low).toEqual([]);
    });
    it(`${mode}: 누를 수 있는 경계(line-control)가 면과 3:1 이상 · 표시(action · needs-hand-bar)가 3:1 이상`, () => {
      expect(ratio(vars['ds-line-control'], vars['ds-surface'])).toBeGreaterThanOrEqual(3);
      expect(ratio(vars['ds-line-control'], vars['ds-surface-sunk'])).toBeGreaterThanOrEqual(3);
      // 사람 아바타의 테두리(= 사람 · 에이전트를 가르는 모양 신호)가 놓이는 면들 — 사진이 없을 때의 바탕(surface-high)과 화면 바탕 위에서도 3:1.
      expect(ratio(vars['ds-line-control'], vars['ds-background'])).toBeGreaterThanOrEqual(3);
      expect(ratio(vars['ds-line-control'], vars['ds-surface-high'])).toBeGreaterThanOrEqual(3);
      expect(ratio(vars['ds-action'], vars['ds-surface'])).toBeGreaterThanOrEqual(3);
      expect(ratio(vars['ds-needs-hand-bar'], vars['ds-surface'])).toBeGreaterThanOrEqual(3);
    });
  }
});
