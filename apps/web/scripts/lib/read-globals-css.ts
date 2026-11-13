/**
 * story 4919 (UI-R6) — globals.css의 `--proof-*` 원값과 몇 별칭이 ds 토큰을 가리키게 됐다(`--proof-bg: var(--ds-background)`).
 * 대비 가드들은 «globals.css 텍스트에서 hex를 읽는다»는 구조라, `var(--ds-*)`를 ds 파일(`styles/design-system.css`)의
 * 같은 테마 값(라이트 = :root 블록 · 다크 = .dark 블록)으로 먼저 풀어 준 글을 돌려준다 — 가드 쪽 파서는 그대로 두고 입력만 풀린다.
 * 풀지 않고 남는 `var(--ds-…)`가 있으면(ds에 없는 이름) 조용히 넘기지 않고 던진다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DS_CSS_RELATIVE = '../styles/design-system.css';

function blockBody(css: string, openRe: RegExp, from = 0): { start: number; end: number; body: string } | null {
  openRe.lastIndex = 0;
  const m = openRe.exec(css.slice(from));
  if (!m) return null;
  const bodyStart = from + m.index + m[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return { start: from + m.index, end: i, body: css.slice(bodyStart, i - 1) };
}

export function parseDsThemes(dsCss: string): { light: Record<string, string>; dark: Record<string, string> } {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const read = (body: string) => {
    const out: Record<string, string> = {};
    for (const m of strip(body).matchAll(/(--ds-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
    return out;
  };
  const light = blockBody(dsCss, /(^|\n):root\s*,\s*\.ds-theme-light\s*\{/);
  const dark = blockBody(dsCss, /(^|\n)\.dark\s*\{/);
  if (!light || !dark) throw new Error('design-system.css: light(:root, .ds-theme-light) / dark(.dark) block not found');
  return { light: read(light.body), dark: read(dark.body) };
}

/** `:root { … }` 블록 안은 라이트, `.dark { … }` 블록 안은 다크 값으로 `var(--ds-x)`를 풀어 돌려준다(그 밖의 글은 그대로). */
export function resolveDsReferences(globalsCss: string, dsCss: string): string {
  const themes = parseDsThemes(dsCss);
  const ranges: { start: number; end: number; theme: 'light' | 'dark' }[] = [];
  for (const [re, theme] of [[/(^|\n)\s*:root\s*\{/g, 'light'], [/(^|\n)\s*\.dark\s*\{/g, 'dark']] as const) {
    let from = 0;
    for (;;) {
      const b = blockBody(globalsCss, new RegExp(re.source), from);
      if (!b) break;
      ranges.push({ start: b.start, end: b.end, theme });
      from = b.end;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    out += globalsCss.slice(cursor, r.start);
    out += globalsCss.slice(r.start, r.end).replace(/var\((--ds-[\w-]+)\)/g, (_all, name: string) => {
      const v = themes[r.theme][name];
      if (v === undefined) throw new Error(`${name} is not defined in design-system.css (${r.theme})`);
      return v;
    });
    cursor = r.end;
  }
  return out + globalsCss.slice(cursor);
}

/** globals.css를 읽어 ds 참조를 푼 글을 돌려준다. `globalsPath` 기본값 = `src/app/globals.css`(이 파일 기준). */
export function readGlobalsCss(globalsPath?: string): string {
  const p = globalsPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/app/globals.css');
  const dsPath = path.resolve(path.dirname(p), DS_CSS_RELATIVE);
  return resolveDsReferences(readFileSync(p, 'utf-8'), readFileSync(dsPath, 'utf-8'));
}
