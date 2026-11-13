// story 4919 (UI-R6) — «옛 팔레트를 한 곳에서 걷기»: shadcn 별칭 · `--proof-*`가 ds 팔레트를 가리킨다.
// 이 시험이 못 박는 것: ① 값 SSOT가 한 곳(design-system.css)이다 — `--proof-*`는 ds 참조(대응표 = 4919 AC2 doc b7aacdb4 표 1)이고, 몇 별칭은 ds를 직접 가리킨다(표 2)
// ② 그 대응이 층 규칙 · 대비 선을 지킨다(풀어 쓴 실제 값으로 계산) ③ 옛 미색 hex가 CSS 선언 값으로 어디에도 남지 않는다(주석은 제외).
// 되돌리면(`--proof-bg: #F7F6F3` 같이 옛 값을 다시 쓰면) ①③이 빨개진다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDsThemes, resolveDsReferences } from '../../scripts/lib/read-globals-css';

const SRC = join(__dirname, '..');
const globalsRaw = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
const dsCss = readFileSync(join(__dirname, 'design-system.css'), 'utf8');
const ds = parseDsThemes(dsCss);

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
function topBlocks(css: string, selector: RegExp): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const m = selector.exec(css.slice(from));
    if (!m) break;
    const bodyStart = from + m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(bodyStart, i - 1));
    from = i;
  }
  return out;
}
/** 한 테마의 선언 모음 — 같은 이름이 여러 블록에 있으면 뒤 블록이 이긴다(CSS 순서와 같다). */
function decls(theme: 'light' | 'dark'): Record<string, string> {
  const blocks = topBlocks(globalsRaw, theme === 'light' ? /(?:^|\n)\s*:root\s*\{/ : /(?:^|\n)\s*\.dark\s*\{/);
  const out: Record<string, string> = {};
  for (const b of blocks) for (const m of strip(b).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const light = decls('light');
const dark = decls('dark');
const themes = [['라이트', 'light', light], ['다크', 'dark', dark]] as const;

const DS = (n: string) => `var(--ds-${n})`;
// 표 1 — `--proof-*` 원값 → ds (라이트 · 다크 같은 참조: 테마 전환은 ds 토큰이 한다)
const PROOF_MAP: Record<string, string> = {
  '--proof-bg': DS('background'),
  '--proof-panel': DS('surface'),
  '--proof-sunk': DS('surface-sunk'),
  '--proof-line': DS('line'),
  '--proof-line-soft': DS('line'),
  '--proof-ink': DS('ink'),
  '--proof-ink-2': DS('ink-2'),
  '--proof-ink-3': DS('ink-3'),
  '--proof-faint': DS('line-strong'),
  '--proof-blue': DS('info'),
  '--proof-blue-soft': DS('info-soft'),
  '--proof-green': DS('done'),
  '--proof-green-soft': DS('done-soft'),
  '--proof-amber': DS('needs-hand'),
  '--proof-amber-soft': DS('needs-hand-soft'),
  '--proof-red': DS('failed'),
  '--proof-red-soft': DS('failed-soft'),
};
// 표 2 — 별칭이 proof를 거치지 않고 ds를 직접 가리키는 것 (PO 판정 N3 · N8 · 팝오버 · 대응)
const ALIAS_DIRECT: Record<string, string> = {
  '--popover': DS('surface-raised'),
  '--primary': DS('action'),
  '--primary-foreground': DS('on-action'),
  '--ring': DS('action'),
  '--input': DS('line-control'),
  '--sidebar-primary': DS('action'),
  '--sidebar-primary-foreground': DS('on-action'),
  '--sidebar-ring': DS('action'),
  '--sidebar-active-fill': DS('action-soft'),
  '--sidebar-active-fill-foreground': DS('action-text'),
};
// 표 2 — proof를 거쳐 ds로 가는 별칭(값은 위 표 1을 따른다)
const ALIAS_VIA_PROOF: Record<string, string> = {
  '--background': 'var(--proof-bg)',
  '--card': 'var(--proof-panel)',
  '--sidebar': 'var(--proof-panel)',
  '--foreground': 'var(--proof-ink)',
  '--card-foreground': 'var(--proof-ink)',
  '--popover-foreground': 'var(--proof-ink)',
  '--sidebar-foreground': 'var(--proof-ink)',
  '--secondary': 'var(--proof-sunk)',
  '--muted': 'var(--proof-sunk)',
  '--accent': 'var(--proof-sunk)',
  '--sidebar-accent': 'var(--proof-sunk)',
  '--secondary-foreground': 'var(--proof-ink-2)',
  '--accent-foreground': 'var(--proof-ink-2)',
  '--sidebar-accent-foreground': 'var(--proof-ink-2)',
  '--muted-foreground': 'var(--proof-ink-3)',
  '--border': 'var(--proof-line)',
  '--sidebar-border': 'var(--proof-line)',
  '--destructive-border': 'var(--proof-red)',
  '--destructive-bg': 'var(--proof-red-soft)',
  '--destructive-tint': 'var(--proof-red-soft)',
  '--success': 'var(--proof-green)',
  '--success-border': 'var(--proof-green)',
  '--success-bg': 'var(--proof-green-soft)',
  '--success-tint': 'var(--proof-green-soft)',
  '--warning': 'var(--proof-amber)',
  '--warning-border': 'var(--proof-amber)',
  '--warning-bg': 'var(--proof-amber-soft)',
  '--warning-tint': 'var(--proof-amber-soft)',
  '--info': 'var(--proof-blue)',
  '--info-border': 'var(--proof-blue)',
  '--info-bg': 'var(--proof-blue-soft)',
  '--info-tint': 'var(--proof-blue-soft)',
};

describe('옛 별칭 · --proof-* → ds 토큰 (4919 AC2 표 1 · 2)', () => {
  for (const [label, , d] of themes) {
    it(`${label}: --proof-* 원값 ${Object.keys(PROOF_MAP).length}개는 ds 참조(옛 hex가 아니다)`, () => {
      for (const [name, ref] of Object.entries(PROOF_MAP)) expect(d[name], `${label} ${name}`).toBe(ref);
    });
    it(`${label}: 별칭 중 ds를 직접 가리키는 ${Object.keys(ALIAS_DIRECT).length}줄(주 행동 · 링 · 입력 경계 · 팝오버)`, () => {
      for (const [name, ref] of Object.entries(ALIAS_DIRECT)) expect(d[name] ?? light[name], `${label} ${name}`).toBe(ref); // 활성 알약 두 줄은 :root 한 곳에만 선언(다크는 ds 토큰이 바꾼다)
    });
    it(`${label}: proof를 거쳐 가는 별칭 ${Object.keys(ALIAS_VIA_PROOF).length}줄은 그대로 proof를 가리킨다(부품이 읽는 이름은 안 바뀜)`, () => {
      for (const [name, ref] of Object.entries(ALIAS_VIA_PROOF)) expect(d[name], `${label} ${name}`).toBe(ref);
    });
  }

  it('ds에 맞는 값이 없는 것은 값을 그대로 둔다 — citron(시그니처 연두) · slate(에이전트 진행) · line-strong 공식', () => {
    expect(light['--proof-citron']).toBe('#5F8706');
    expect(dark['--proof-citron']).toBe('#C7F85A');
    expect(light['--proof-slate']).toBe('#636F7D');
    expect(light['--proof-line-strong']).toBe('color-mix(in oklch, var(--proof-line) 50%, var(--proof-ink) 50%)');
  });

  it('PO N5(b) — --destructive도 ds-failed를 따른다(글 211곳이 같은 변수라 옛 빨강을 두면 다크 옅은 면 위 글이 3.98로 AA 미달)', () => {
    expect(light['--destructive']).toBe(DS('failed'));
    expect(dark['--destructive']).toBe(DS('failed'));
  });

  it('참조한 ds 토큰은 모두 design-system.css에 있다(없는 이름이면 풀기에서 던진다)', () => {
    expect(() => resolveDsReferences(globalsRaw, dsCss)).not.toThrow();
  });
});

// ── 풀어 쓴 실제 값으로 층 · 대비 선을 계산한다 ─────────────────────────────────────────────
const resolved = resolveDsReferences(globalsRaw, dsCss);
function resolvedHex(theme: 'light' | 'dark', name: string): string {
  const blocks = topBlocks(resolved, theme === 'light' ? /(?:^|\n)\s*:root\s*\{/ : /(?:^|\n)\s*\.dark\s*\{/);
  const map: Record<string, string> = {};
  for (const b of blocks) for (const m of strip(b).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[m[1]!] = m[2]!.trim();
  let v = map[name];
  for (let i = 0; i < 5 && v && v.startsWith('var('); i++) v = map[v.slice(4, -1)];
  if (!v || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`${theme} ${name} did not resolve to a hex (got ${v})`);
  return v.toLowerCase();
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgbOf = (hex: string) => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
function lightness(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}
function contrast(a: string, b: string): number {
  const rel = (h: string) => { const [r, g, bl] = rgbOf(h); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [rel(a), rel(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('이은 값이 층 규칙 · 대비 선을 지킨다(풀어 쓴 실제 값)', () => {
  for (const [label, key] of [['라이트', 'light'], ['다크', 'dark']] as const) {
    it(`${label}: 옛 별칭이 ds와 같은 값으로 풀린다 — background · card · muted · border · input · primary · popover`, () => {
      const t = ds[key];
      expect(resolvedHex(key, '--background')).toBe(t['--ds-background']!.toLowerCase());
      expect(resolvedHex(key, '--card')).toBe(t['--ds-surface']!.toLowerCase());
      expect(resolvedHex(key, '--muted')).toBe(t['--ds-surface-sunk']!.toLowerCase());
      expect(resolvedHex(key, '--border')).toBe(t['--ds-line']!.toLowerCase());
      expect(resolvedHex(key, '--input')).toBe(t['--ds-line-control']!.toLowerCase());
      expect(resolvedHex(key, '--primary')).toBe(t['--ds-action']!.toLowerCase());
      expect(resolvedHex(key, '--popover')).toBe(t['--ds-surface-raised']!.toLowerCase());
    });
    it(`${label}: 바탕 → 내용 칸 ≥ .03 · 내용 칸 → 들어간 칸 ≥ .05 (층 규칙이 옛 별칭 이름에도 선다)`, () => {
      const bg = lightness(resolvedHex(key, '--background'));
      const card = lightness(resolvedHex(key, '--card'));
      const muted = lightness(resolvedHex(key, '--muted'));
      expect(Math.abs(card - bg), `${label} card−background`).toBeGreaterThanOrEqual(0.03);
      expect(Math.abs(card - muted), `${label} card−muted`).toBeGreaterThanOrEqual(0.05);
    });
    it(`${label}: 보조 글(muted-foreground)은 들어간 칸 · 내용 칸 · 바탕 위에서 4.5:1 이상`, () => {
      const fg = resolvedHex(key, '--muted-foreground');
      for (const bg of ['--muted', '--card', '--background']) expect(contrast(fg, resolvedHex(key, bg)), `${label} muted-foreground on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${label}: 입력 경계(--input)는 내용 칸 위에서 3:1 이상 — 옛 값은 1.27이었다`, () => {
      expect(contrast(resolvedHex(key, '--input'), resolvedHex(key, '--card'))).toBeGreaterThanOrEqual(3);
    });
    it(`${label}: 고체 --destructive 위 글(text-background — 바탕을 뚫은 글)은 4.5:1 이상, 글 --destructive는 카드 · 옅은 면 위에서 4.5:1 이상`, () => {
      const solid = resolvedHex(key, '--destructive');
      expect(contrast(resolvedHex(key, '--background'), solid), `${label} text-background on bg-destructive`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(solid, resolvedHex(key, '--card')), `${label} text-destructive on card`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(solid, resolvedHex(key, '--destructive-bg')), `${label} text-destructive on destructive-bg`).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('양성대조 — 예전 꼴(고체 위 흰 글 text-white)은 다크 ds-failed 위에서 3:1 아래라 text-background로 바꾼 것이다', () => {
    expect(contrast('#ffffff', ds.dark['--ds-failed']!.toLowerCase())).toBeLessThan(3);
    expect(contrast(ds.dark['--ds-background']!.toLowerCase(), ds.dark['--ds-failed']!.toLowerCase())).toBeGreaterThanOrEqual(4.5);
  });
});

// ── 옛 미색이 CSS 선언 값으로 남지 않는다(주석은 보지 않는다) ─────────────────────────────────
const OLD_HEX = ['#F7F6F3', '#F1EFEA', '#E7E4DE', '#EEEBE5', '#ECEAE2', '#0B0C0D', '#17191C', '#111315', '#2B2E2D', '#232628'].map((h) => h.toLowerCase());
const OLD_RGB = ['247, ?246, ?243', '241, ?239, ?234', '231, ?228, ?222', '238, ?235, ?229', '252, ?251, ?247', '11, ?12, ?13', '23, ?25, ?28', '17, ?19, ?21', '43, ?46, ?45', '35, ?38, ?40'];
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === '.harness') return [];
    return statSync(p).isDirectory() ? cssFiles(p) : n.endsWith('.css') ? [p] : [];
  });
}
export function oldPaletteDeclarations(css: string): string[] {
  const found: string[] = [];
  for (const m of strip(css).matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+);/g)) {
    const value = m[2]!.toLowerCase();
    if (OLD_HEX.some((h) => value.includes(h)) || OLD_RGB.some((r) => new RegExp(`rgba?\\(\\s*${r}\\b`).test(value))) found.push(`${m[1]}: ${m[2]!.trim()}`);
  }
  return found;
}
describe('옛 미색 실값 가드 — 선언 값에 옛 hex · rgb가 없다', () => {
  const files = cssFiles(SRC);
  it('src 아래 모든 .css가 대상이다(globals.css 포함)', () => {
    expect(files.some((f) => f.endsWith('app/globals.css'))).toBe(true);
    expect(files.some((f) => f.endsWith('styles/design-system.css'))).toBe(true);
  });
  it('옛 라이트 미색(247,246,243 · 241,239,234 · 231,228,222 · 238,235,229 · 252,251,247) · 옛 다크 패널색 hex가 선언 값으로 하나도 없다', () => {
    const offenders = files.flatMap((f) => oldPaletteDeclarations(readFileSync(f, 'utf8')).map((d) => `${f.replace(SRC, 'src')}: ${d}`));
    expect(offenders).toEqual([]);
  });
  it('양성대조 — 가드가 옛 값을 실제로 잡는다(hex · rgb · 알파 rgb · 주석은 무시)', () => {
    expect(oldPaletteDeclarations(':root { --proof-bg: #F7F6F3; }')).toHaveLength(1);
    expect(oldPaletteDeclarations(':root { --x: rgba(252, 251, 247, .62); }')).toHaveLength(1);
    expect(oldPaletteDeclarations('.dark { --x: #0b0c0d; }')).toHaveLength(1);
    expect(oldPaletteDeclarations('/* #F7F6F3 옛 값 */ :root { --x: var(--ds-background); }')).toHaveLength(0);
  });
});

// ── 고체 --destructive 위 글은 «바탕을 뚫은 글»(text-background)이다 — 흰 글(text-white · text-on-scrim)은 다크 ds-failed(옅은 분홍) 위에서 1.7:1 ──────────
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === '.harness' || n === '.next') return [];
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
/** `bg-destructive`(고체 — `-tint` · `-bg` · `/10` 같은 옅은 면 · border 제외)와 흰 글 클래스가 같은 줄에 있는 자리. */
export function whiteTextOnSolidDestructive(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (/(^|[\s"'`])bg-destructive(?![-\w/])/.test(code) && /(^|[\s"'`])(dark:)?text-(white|on-scrim)(?![-\w])/.test(code)) out.push(line.trim());
  }
  return out;
}
describe('고체 bg-destructive 위 글 — text-background(양 테마 4.5:1 이상)', () => {
  it('src 전체에 고체 destructive + text-white/text-on-scrim 조합이 없다', () => {
    const offenders = sourceFiles(SRC).flatMap((f) => whiteTextOnSolidDestructive(readFileSync(f, 'utf8')).map((l) => `${f.replace(SRC, 'src')}: ${l.slice(0, 120)}`));
    expect(offenders).toEqual([]);
  });
  it('글이 올라가는 넷이 모두 text-background를 쓴다(storage-delete-dialog · audio-recorder · verify-rail · kanban-board 알림)', () => {
    const at = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
    expect(at('components/storage/storage-delete-dialog.tsx')).toContain('bg-destructive text-background hover:brightness-95');
    expect(at('components/meetings/audio-recorder.tsx')).toContain('bg-destructive px-4 py-2 text-sm font-medium text-background hover:brightness-95');
    expect(at('app/onboarding/verify-rail.tsx')).toContain('rounded-full bg-destructive text-background');
    expect(at('components/kanban/kanban-board.tsx')).toContain('border border-destructive bg-destructive px-4 py-3 text-sm text-background');
  });
  it('양성대조 — 가드가 옛 꼴을 잡는다(흰 글 · text-on-scrim · 다크 전용 글색)', () => {
    expect(whiteTextOnSolidDestructive('<b className="bg-destructive text-white hover:bg-destructive/90" />')).toHaveLength(1);
    expect(whiteTextOnSolidDestructive('<i className="rounded-full bg-destructive text-on-scrim" />')).toHaveLength(1);
    expect(whiteTextOnSolidDestructive('<i className="bg-destructive text-sm dark:text-white" />')).toHaveLength(1);
    expect(whiteTextOnSolidDestructive('<i className="bg-destructive-tint text-white" />')).toHaveLength(0); // 옅은 면은 대상 아님
    expect(whiteTextOnSolidDestructive('<i className="bg-destructive text-background" />')).toHaveLength(0);
  });
});
