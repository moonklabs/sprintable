// story #4325 — 색 토큰은 **완성된 색**(`--border: var(--proof-line)` → `#E7E4DE` · oklch …)이다. 그걸 `hsl(var(--border))`처럼 색 함수로
// 감싸면 `hsl(#E7E4DE)`가 되어 **선언 전체가 무효** — 테두리는 글자색으로, 배경은 투명으로, 그림자 링은 사라졌다(develop 다섯 줄).
// 이 저장소엔 HSL 성분(`210 40% 98%`)만 담는 토큰이 없다(아래 테스트가 고정) — 그래서 `hsl/hsla/rgb/rgba(var(--…))` 모양은 늘 틀린 것.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
// 앞 글자 경계는 \b가 아니라 «영숫자 · 하이픈이 아님» — Tailwind 임의값 `1px_hsl(…)`의 `_` 뒤도 잡는다(\b는 `_`를 단어 글자로 봐서 놓쳤다).
const WRAP_RE = /(?<![A-Za-z0-9-])(?:hsla?|rgba?)\(\s*var\(--[\w-]+\)/g;
const BARE_COMPONENT_TOKEN_RE = /^\s*--[a-z0-9-]+:\s*[\d.]+(?:deg)?\s+[\d.]+%\s+[\d.]+%/m;

/** 다른 PR이 고치는 중인 자리(파일별 개수 상한) — 그 PR(4684 · 미르코)이 병합되면 이 항목을 지운다(늘면 RED · 줄면 통과). */
const PENDING_ELSEWHERE: ReadonlyArray<{ file: string; count: number; reason: string }> = [
  { file: 'components/docs/doc-content-renderer.tsx', count: 5, reason: 'PR 4684(미르코)가 고침 — 병합 뒤 이 항목을 지운다' },
];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== '.next') files(p, out); }
    else if (/\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

export function findWrappedTokens(text: string): number {
  return (text.match(WRAP_RE) ?? []).length;
}

function scan(root = SRC): Record<string, number> {
  const byFile: Record<string, number> = {};
  for (const abs of files(root)) {
    const n = findWrappedTokens(readFileSync(abs, 'utf8'));
    if (n) byFile[path.relative(root, abs).split(path.sep).join('/')] = n;
  }
  return byFile;
}

describe('색 토큰을 색 함수로 감싸지 않는다(story #4325)', () => {
  it('양성 — CSS 선언 · Tailwind 임의값 · 그림자 · 공백 · hsla/rgb/rgba', () => {
    expect(findWrappedTokens('.a { border-color: hsl(var(--border)); }')).toBe(1);
    expect(findWrappedTokens('border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20')).toBe(2);
    expect(findWrappedTokens('shadow-[0_0_0_1px_hsl(var(--sidebar-border))]')).toBe(1);
    expect(findWrappedTokens('color: rgba( var(--x) / 0.5); background: hsla(var(--y), 1)')).toBe(2);
  });

  it('음성 — var() 그대로 · color-mix · 숫자 인자 hsl() · 토큰 정의', () => {
    expect(findWrappedTokens('.a { border-color: var(--border); }')).toBe(0);
    expect(findWrappedTokens('shadow-[0_0_0_1px_var(--sidebar-border)]')).toBe(0);
    expect(findWrappedTokens('color: color-mix(in oklch, var(--border) 50%, transparent)')).toBe(0);
    expect(findWrappedTokens('color: hsl(210 40% 98%)')).toBe(0);
  });

  it('전제 — HSL 성분만 담는 토큰이 없다(있으면 hsl(var()) 가 맞는 자리가 생겨 이 가드를 다시 봐야 한다)', () => {
    const css = files(SRC).filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8'));
    expect(css.some((t) => BARE_COMPONENT_TOKEN_RE.test(t))).toBe(false);
  });

  it('⭐실 저장소 — 감싼 토큰 0(다른 PR이 고치는 중인 자리만 그 수 그대로)', () => {
    const byFile = scan();
    for (const p of PENDING_ELSEWHERE) {
      expect(byFile[p.file] ?? 0, `${p.file} — ${p.reason}`).toBeLessThanOrEqual(p.count);
      delete byFile[p.file];
    }
    expect(byFile).toEqual({});
  });
});
