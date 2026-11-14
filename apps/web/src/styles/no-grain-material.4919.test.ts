// story 4919 (UI-R6) — 선생님 11-14: 8-25의 «결 · 깊이»(종이 그레인 + 뜬 · 눌린 그림자)를 걷어 다른 화면처럼 평평하게. 이 시험이 못 박는 것:
// ① globals.css에 그레인 · 뜸/눌림 그림자 토큰이 없고, `.proof-surface`를 고르는 규칙은 모두 모양(position + border-radius)뿐이다 — 겹(::before/::after) · background-image · 그림자 · 블렌드 0, 규칙은 하나
// ② apps/web 전체(src · scripts · e2e · 고정 입력 파일 — 시험 파일만 뺀다)에 `proof-surface-lift` · `proof-surface-press` · 토큰 이름이 «원문 그대로» 한 곳도 없다 — 주석을 걷어내는 일도 하지 않는다
//    (걷어내기는 `//` · `/*`가 든 진짜 클래스 문자열을 지워 가드를 속일 수 있다. 그래서 옛 이름은 주석에도 적지 않는다)
// ③ 실제로 `.proof-surface`를 입는 부품(결재 상세 우 열 · 목표 상세 카드 둘 · ProofCapsule · Badge · label-chip)이 아직 그 클래스(모양)를 쓴다 — 가드가 빈 껍데기가 아닌지(양성 대조)
// 되돌리면(그레인 변수 · `::before` 겹 · lift/press 클래스를 다시 넣으면) ①②가 빨개진다. 면 «픽셀 std 0»은 진짜 Chromium으로 따로 쟀다(PR 본문).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..', '..');
const SRC = join(WEB, 'src');
const SELF = 'src/styles/no-grain-material.4919.test.ts';
const globalsRaw = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ''); // CSS 주석은 파서도 그렇게 걷는다 — 선언을 숨길 수 없다
const globals = stripCss(globalsRaw);

const SKIP_DIRS = new Set(['node_modules', '.next', '.harness', '.turbo', 'coverage', 'dist', 'test-results', 'playwright-report']);
const TEXT = /\.(?:tsx?|mjs|cjs|js|jsx|css|json|txt|md|html|ya?ml)$/;
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (TEXT.test(name) && !/\.test\.[^.]+$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => p.slice(WEB.length + 1);

describe('4919 — 결(그레인) · 뜸/눌림 그림자를 걷었다', () => {
  it('globals.css에 그레인 · 뜸/눌림 그림자 토큰 · 노이즈 SVG가 없다', () => {
    for (const name of ['--paper-grain', '--elev-lift', '--emboss-press']) expect(globals.includes(name), `${name}이 남아 있다`).toBe(false);
    expect(/feTurbulence|fractalNoise/.test(globals), '노이즈 SVG가 남아 있다').toBe(false);
  });

  it('`.proof-surface`를 고르는 규칙은 하나이고 모양(position + border-radius)만 갖는다 — 겹 · background · 그림자 · 블렌드 0', () => {
    const rules = [...globals.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! })).filter((r) => r.sel.includes('proof-surface'));
    expect(rules.map((r) => r.sel), '.proof-surface를 고르는 규칙(::before · -lift · -press 포함)은 정확히 이 하나').toEqual(['.proof-surface']);
    const props = [...rules[0]!.body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]).sort();
    expect(props).toEqual(['border-radius', 'position']);
    // 다른 규칙이 `.proof-surface` 부품에 그림 · 그림자를 얹는 길(자손 · 속성 선택자)도 없다
    expect(/proof-surface[^{}]*\{[^{}]*(?:background-image|box-shadow|mix-blend-mode)/.test(globals)).toBe(false);
  });

  it('apps/web 전체(주석 포함 원문)에 proof-surface-lift · proof-surface-press · 그 토큰 이름이 없다', () => {
    const offenders: string[] = [];
    for (const f of files(WEB)) {
      if (rel(f) === SELF) continue;
      if (/proof-surface-(?:lift|press)|paper-grain|elev-lift|emboss-press/.test(readFileSync(f, 'utf8'))) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it('양성 대조 — 그 클래스를 입던 부품은 아직 모양(proof-surface)을 쓴다(가드가 빈 껍데기가 아니다)', () => {
    const uses = (r: string) => /\bproof-surface\b/.test(readFileSync(join(SRC, r), 'utf8'));
    for (const r of [
      'components/proof-capsule/proof-capsule.tsx',
      'components/ui/badge.tsx',
      'components/ui/label-chip.tsx',
      'app/(authenticated)/gates/[id]/page.tsx',
      'app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx',
    ]) expect(uses(r), `${r}이 proof-surface를 안 쓴다`).toBe(true);
    // 스캔 범위 대조: 시험이 읽는 파일 수가 적정선(수백 개)이고 src · scripts가 둘 다 들어 있다
    const all = files(WEB).map(rel);
    expect(all.length).toBeGreaterThan(300);
    expect(all.some((f) => f.startsWith('src/'))).toBe(true);
    expect(all.some((f) => f.startsWith('scripts/fixtures/'))).toBe(true);
  });
});
