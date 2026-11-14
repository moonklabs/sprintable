// story 4919 (UI-R6) — 선생님 11-14: 8-25의 «결 · 깊이»(종이 그레인 + 뜬 · 눌린 그림자)를 걷어 다른 화면처럼 평평하게. 이 시험이 못 박는 것:
// ① globals.css에 그레인(`--paper-grain*`) · 뜸/눌림 그림자 토큰(`--elev-lift` · `--emboss-press`)이 없고, `.proof-surface`는 모양(position + 라운드)만 갖는다 — 겹(::before) · background-image · 그림자 0
// ② 소스(주석 제외)에 `proof-surface-lift` · `proof-surface-press` · 그 토큰 이름이 한 곳도 없다
// ③ 실제로 `.proof-surface`를 입는 부품(결재 상세 우 열 · 목표 상세 카드 둘 · ProofCapsule · Badge · label-chip)이 아직 그 클래스(모양)를 쓴다 — 가드가 빈 껍데기가 아닌지(양성 대조)
// 되돌리면(그레인 변수 · `::before` 겹 · lift/press 클래스를 다시 넣으면) ①②가 빨개진다. 면 «픽셀 std 0»은 진짜 Chromium으로 따로 쟀다(PR 본문).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const globals = stripCss(readFileSync(join(SRC, 'app/globals.css'), 'utf8'));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.(tsx?|css)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('4919 — 결(그레인) · 뜸/눌림 그림자를 걷었다', () => {
  it('globals.css에 그레인 · 뜸/눌림 그림자 토큰이 없다', () => {
    for (const name of ['--paper-grain', '--paper-grain-opacity', '--paper-grain-blend', '--elev-lift', '--emboss-press']) {
      expect(globals.includes(name), `${name}이 남아 있다`).toBe(false);
    }
    expect(/feTurbulence|fractalNoise/.test(globals), '노이즈 SVG가 남아 있다').toBe(false);
  });

  it('`.proof-surface`는 모양(position + 라운드)만 갖는다 — ::before 겹 · background · 그림자 · 블렌드 0', () => {
    expect(/\.proof-surface::(?:before|after)/.test(globals), '.proof-surface에 겹이 남아 있다').toBe(false);
    expect(/\.proof-surface-(?:lift|press)/.test(globals), '.proof-surface-lift / -press 규칙이 남아 있다').toBe(false);
    const rule = /\.proof-surface\s*\{([^}]*)\}/.exec(globals);
    expect(rule, '.proof-surface 규칙이 있어야 한다(모양)').not.toBeNull();
    const props = [...rule![1]!.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]).sort();
    expect(props).toEqual(['border-radius', 'position']);
  });

  it('소스(주석 제외)에 proof-surface-lift · proof-surface-press · 그 토큰 이름이 없다', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const text = f.endsWith('.css') ? stripCss(readFileSync(f, 'utf8')) : stripTs(readFileSync(f, 'utf8'));
      if (/proof-surface-(?:lift|press)|paper-grain|elev-lift|emboss-press/.test(text)) offenders.push(f.slice(SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it('양성 대조 — 그 클래스를 입는 부품은 아직 모양(proof-surface)을 쓴다(가드가 빈 껍데기가 아니다)', () => {
    const uses = (rel: string) => /\bproof-surface\b/.test(stripTs(readFileSync(join(SRC, rel), 'utf8')));
    for (const rel of [
      'components/proof-capsule/proof-capsule.tsx',
      'components/ui/badge.tsx',
      'components/ui/label-chip.tsx',
      'app/(authenticated)/gates/[id]/page.tsx',
      'app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx',
    ]) {
      expect(uses(rel), `${rel}이 proof-surface를 안 쓴다`).toBe(true);
    }
  });
});
