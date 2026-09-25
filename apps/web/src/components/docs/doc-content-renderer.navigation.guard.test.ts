// story #4309 AC5 — 문서 본문 렌더러 안의 내부 이동은 진짜 링크 + 클라이언트 라우터다. `window.location` 대입 · assign · replace
// (전체 새로고침 → flat 주소면 서버 307까지)는 금지. 주석은 빼고 코드만 잰다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = join(__dirname, 'doc-content-renderer.tsx');
const FORBIDDEN = /\b(?:window\.)?location\s*\.\s*(?:href\s*=(?!=)|assign\s*\(|replace\s*\()|\bwindow\.location\s*=(?!=)/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function countFullPageNavigations(source: string): number {
  return stripComments(source).match(FORBIDDEN)?.length ?? 0;
}

describe('doc-content-renderer — 본문 내부 이동에 window.location 금지(story #4309)', () => {
  it('⭐렌더러 코드에 window.location 이동 0', () => {
    expect(countFullPageNavigations(readFileSync(RENDERER, 'utf8'))).toBe(0);
  });

  it('양성 대조 — 예전 모양(대입 · assign · replace)은 센다 · 읽기 · 비교 · 주석은 안 센다', () => {
    expect(countFullPageNavigations("const go = () => { window.location.href = flatHref(`/docs/${slug}`); };")).toBe(1);
    expect(countFullPageNavigations('window.location.assign(url); location.replace(url); window.location = url;')).toBe(3);
    expect(countFullPageNavigations("const q = window.location.search; if (window.location.href === x) {}")).toBe(0);
    expect(countFullPageNavigations('// window.location.href = old\n/* location.assign(x) */')).toBe(0);
  });
});
