// UI-3(a9d56577) — 새 토큰 파일 회귀가드: ① 모든 뜻 이름이 밝음(:root) · 어둠(.dark) 둘 다 정의 ② Tailwind `@theme inline` 연결 ③ 별칭 없음(옛 이름을 정의하지 않는다)
// ④ 대비 — 글자 조합 4.5:1 · 누를 수 있는 경계 3:1(상대 휘도, 이 파일의 값을 읽어 계산).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'design-system.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`));
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
  it('`.ds-theme-light`는 밝음 값 «한 벌»을 :root와 같은 규칙에서 쥔다 — 어두운 화면 안 밝음 틀(견본)이 별도 복사본 없이 밝게 보인다', () => {
    expect(css).toMatch(/(?:^|\n):root,\s*\.ds-theme-light\s*\{/);
    expect(css.match(/\.ds-theme-light\s*\{/g)?.length).toBe(1);
  });

  it('밝음 · 어둠이 같은 이름 집합을 정의한다(한쪽만 있으면 한 테마가 비어 렌더된다)', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    expect(Object.keys(light).length).toBe(28);
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
    // 허용: 뜻 이름(--ds-) + 그것을 Tailwind 이름 공간에 잇는 ds 접두 이름(색 · 글자 · 모서리 · 밀도 · 그림자 · 움직임). 옛 이름은 여전히 0.
    const DS_NAMESPACES = ['--ds-', '--color-ds-', '--text-ds-', '--radius-ds-', '--spacing-ds-', '--shadow-ds-', '--animate-ds-'];
    const legacy = defined.filter((n) => !DS_NAMESPACES.some((p) => n.startsWith(p)));
    expect(legacy).toEqual([]);
  });

  it('globals.css가 이 파일을 가져온다', () => {
    const globals = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
    expect(globals).toContain('@import "../styles/design-system.css";');
  });

  const TEXT_PAIRS: Array<[string, string]> = [
    ['ds-ink', 'ds-surface'], ['ds-ink', 'ds-background'], ['ds-ink', 'ds-surface-high'],
    ['ds-ink-2', 'ds-surface'], ['ds-ink-3', 'ds-surface'], ['ds-ink-3', 'ds-surface-sunk'], ['ds-ink-3', 'ds-surface-high'], ['ds-ink-3', 'ds-background'], ['ds-action-text', 'ds-background'],
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

// 밀도 · 그림자 · 움직임 토큰(UI-3 4886 AC1) — 값은 «부품 안에 흩어져 있던 그대로»다(이름만 붙임 = 화면 변화 0). 그 값이 바뀌면 빨개진다.
describe('design-system.css — 밀도 · 그림자 · 움직임 이름 토큰', () => {
  const rem = (name: string) => {
    const m = css.match(new RegExp(`--spacing-${name}:\\s*([\\d.]+)rem;`));
    if (!m) throw new Error(`--spacing-${name} 없음`);
    return Number(m[1]) * 16;
  };
  it('⭐밀도: 작은 단추 28 · 촘촘한 칸 32 · 큰 단추 · 입력칸 36 · 폰 바닥 44 · 큰 아이콘 단추 48 · 목록 줄 56 (px)', () => {
    expect({
      'ds-control-sm': rem('ds-control-sm'),
      'ds-compact': rem('ds-compact'),
      'ds-control': rem('ds-control'),
      'ds-touch': rem('ds-touch'),
      'ds-control-xl': rem('ds-control-xl'),
      'ds-row': rem('ds-row'),
    }).toEqual({ 'ds-control-sm': 28, 'ds-compact': 32, 'ds-control': 36, 'ds-touch': 44, 'ds-control-xl': 48, 'ds-row': 56 });
  });

  it('⭐그림자: popup = Tailwind 기본 shadow-md 값 · overlay = 기본 shadow-xl 값 그대로(이전 부품이 쓰던 값 — 화면이 안 바뀐다)', () => {
    const tw = readFileSync(join(__dirname, '../../node_modules/tailwindcss/theme.css'), 'utf8');
    const twVal = (n: string) => tw.match(new RegExp(`--shadow-${n}:\\s*([^;]+);`))![1]!.trim();
    const dsVal = (n: string) => css.match(new RegExp(`--shadow-ds-${n}:\\s*([^;]+);`))![1]!.trim();
    expect(dsVal('popup')).toBe(twVal('md'));
    expect(dsVal('overlay')).toBe(twVal('xl'));
  });

  it('⭐움직임: 빠름 100ms · 움직임 줄이기 0 · 숨쉬기 2초 · 숨쉬기 모양은 Tailwind pulse와 같다(50%에서 투명도 0.5)', () => {
    const v = (n: string) => css.match(new RegExp(`--ds-duration-${n}:\\s*([^;]+);`))![1]!.trim();
    expect([v('fast'), v('instant'), v('pulse'), v('enter')]).toEqual(['100ms', '0ms', '2s', '300ms']);
    const tw = readFileSync(join(__dirname, '../../node_modules/tailwindcss/theme.css'), 'utf8');
    const twAnim = tw.match(/--animate-pulse:\s*([^;]+);/)![1]!.trim();
    const dsAnim = css.match(/--animate-ds-pulse:\s*([^;]+);/)![1]!.trim();
    expect(dsAnim.replace('ds-pulse', 'pulse').replace('var(--ds-duration-pulse)', '2s')).toBe(twAnim);
    expect(css).toMatch(/@keyframes ds-pulse\s*\{\s*50%\s*\{\s*opacity:\s*0\.5;/);
  });

  it('⭐토스트 들어오기: 옛 globals.css의 slide-in과 같은 값이다(0.3초 ease-out · 오른쪽 100%에서 투명 → 제자리 불투명)', () => {
    const globals = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
    const frames = (src: string, name: string) => norm(src.match(new RegExp(`@keyframes ${name}\\s*\\{(.*?\\})\\s*\\}`, 's'))![1]!);
    expect(frames(css, 'ds-slide-in')).toBe(frames(globals, 'slide-in'));
    expect(css.match(/--animate-ds-slide-in:\s*([^;]+);/)![1]!.trim()).toBe('ds-slide-in var(--ds-duration-enter) ease-out');
    expect(globals).toMatch(/animation:\s*slide-in 0\.3s ease-out;/);
  });
});
