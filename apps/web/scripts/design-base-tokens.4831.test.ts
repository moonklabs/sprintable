// story 4831 (바탕 한 벌 규격 v1 §1 · §4) — globals.css가 규격이 정한 이름을 모두, 두 테마에서 같은 이름으로 가진다.
// `text-micro` · `text-display`(글자 눈금의 빈 두 단)와 겹침색 9개(overlay-fill 1~3 · overlay-line 1~2 · scrim 1~3 · on-scrim)가 ① @theme에서 유틸리티 이름으로 열려 있고
// ② :root(라이트)와 .dark(다크) 모두에 값이 있어야 한다. 하나라도 빠지면 그 이름을 쓰는 화면이 한 테마에서 조용히 투명해지므로 빨강이다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../src/app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 중괄호 짝으로 블록 본문을 잘라 온다(시작 패턴이 처음 나오는 곳 기준). */
function block(startPattern: RegExp): string {
  const m = startPattern.exec(css);
  if (!m) throw new Error(`블록을 못 찾음: ${startPattern}`);
  let depth = 0;
  for (let i = css.indexOf('{', m.index); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', m.index) + 1, i);
  }
  throw new Error('블록이 닫히지 않음');
}

const theme = block(/@theme inline\s*\{/);
const light = block(/(^|\n):root\s*\{/);
const dark = block(/(^|\n)\.dark\s*\{/);

const OVERLAY = ['overlay-fill-1', 'overlay-fill-2', 'overlay-fill-3', 'overlay-line-1', 'overlay-line-2', 'scrim-1', 'scrim-2', 'scrim-3', 'on-scrim'];

describe('글자 눈금의 빈 두 단(규격 v1 §1)', () => {
  it('text-micro 10px · text-display 32px가 줄간격과 짝으로 있다', () => {
    expect(theme).toMatch(/--text-micro:\s*10px;/);
    expect(theme).toMatch(/--text-micro--line-height:\s*[\d.]+;/);
    expect(theme).toMatch(/--text-display:\s*32px;/);
    expect(theme).toMatch(/--text-display--line-height:\s*[\d.]+;/);
  });

  it('이미 있는 editorial meta 11px · ui 13px는 그대로다(눈금의 11 · 13단)', () => {
    expect(theme).toMatch(/--text-editorial-meta:\s*11px;/);
    expect(theme).toMatch(/--text-editorial-ui:\s*13px;/);
  });
});

describe('겹침색 토큰(규격 v1 §4)', () => {
  it.each(OVERLAY)('%s — @theme에서 유틸리티 이름(--color-…)으로 열려 있다', (name) => {
    expect(theme).toMatch(new RegExp(`--color-${name}:\\s*var\\(--${name}\\);`));
  });

  it.each(OVERLAY)('%s — 라이트와 다크 둘 다에 값이 있다', (name) => {
    expect(light).toMatch(new RegExp(`--${name}:\\s*oklch\\(`));
    expect(dark).toMatch(new RegExp(`--${name}:\\s*oklch\\(`));
  });

  it('희미한 면 · 선은 테마마다 방향이 반대다(라이트=검정 알파, 다크=흰 알파) — 같은 값이면 한 테마에서 안 보인다', () => {
    for (const name of ['overlay-fill-1', 'overlay-fill-2', 'overlay-fill-3', 'overlay-line-1', 'overlay-line-2']) {
      const l = new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(light)![1];
      const d = new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(dark)![1];
      expect(l).toMatch(/^oklch\(0 0 0 \//);
      expect(d).toMatch(/^oklch\(1 0 0 \//);
    }
  });

  it('장막 · 장막 위 글자는 두 테마 같은 값이다', () => {
    for (const name of ['scrim-1', 'scrim-2', 'scrim-3', 'on-scrim']) {
      const l = new RegExp(`--${name}:\\s*([^;]+);`).exec(light)![1];
      const d = new RegExp(`--${name}:\\s*([^;]+);`).exec(dark)![1];
      expect(l).toBe(d);
    }
  });
});
