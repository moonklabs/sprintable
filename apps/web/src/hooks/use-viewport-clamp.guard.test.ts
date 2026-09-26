// story #4342 AC2 — 부류 가드: «한쪽 맞춤(left-N · right-N · left-[…] — 0만이 아니라 띄운 맞춤도 · PO가 짚은 scale-ladder left-3) + 고정/최소 폭(w-N · w-[…] · min-w-[…]) + top-full absolute» 드롭다운은 좁은 화면에서
// 뷰포트 밖으로 나갈 수 있다 → 그 패널은 useViewportClampRef(표지 data-dropdown-panel)와 폭 상한 max-w-[calc(100vw-1rem)]를 함께 단다.
// 원천 글자 스캔이라 한계가 있다: top-full 없이 흐름 아래 붙는 목록(엔티티 후보 등)과 여러 줄로 쪼갠 className은 못 본다 — 그 자리는 PR 본문 전수 표.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
// 데스크톱 전용(좁은 화면에서 안 뜸)이라 제외 — 이유를 함께 둔다.
const EXEMPT: Record<string, string> = {
  'components/nav/notification-bell.tsx': '`hidden … lg:flex` — lg(1024px) 미만에선 패널 자체가 안 뜬다(모바일은 다른 진입)',
};
const ANCHORED = /(?=[^"'`]*\babsolute\b)(?=[^"'`]*\btop-full\b)(?=[^"'`]*(?:^|[\s"'`])-?(?:left|right)-(?:\d|\[))(?=[^"'`]*(?:\bmin-w-\[|\bw-\[|\bw-\d))[^"'`]*/;

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

function scan(src: string): Array<{ line: number; ok: boolean }> {
  const lines = src.split('\n');
  const found: Array<{ line: number; ok: boolean }> = [];
  lines.forEach((ln, i) => {
    const m = ANCHORED.exec(ln);
    if (!m) return;
    const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    found.push({ line: i + 1, ok: m[0].includes('max-w-[calc(100vw-1rem)]') && window.includes('data-dropdown-panel=') });
  });
  return found;
}

describe('뷰포트 밖 드롭다운 부류 가드(story #4342)', () => {
  it('양성 대조 — 옛 목차 모양은 걸리고, 처방한 모양은 통과', () => {
    const old = '<div className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl">';
    const fixed = '<div ref={listClampRef} data-dropdown-panel="doc-toc" className="absolute right-0 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-1rem)] overflow-hidden">';
    expect(scan(old)).toEqual([{ line: 1, ok: false }]);
    expect(scan(fixed)).toEqual([{ line: 1, ok: true }]);
    expect(scan('<span className="absolute inset-y-0 left-0 w-1 bg-x" />')).toEqual([]);
    // 띄운 맞춤(left-3)도 같은 부류 — PO가 짚은 scale-ladder:263 옛 모양.
    expect(scan('<div className="absolute left-3 top-full z-20 mt-2 w-56 rounded-lg border">')).toEqual([{ line: 1, ok: false }]);
  });

  it('src 전체 .tsx — 한쪽 맞춤 고정 폭 top-full 드롭다운은 모두 밀어 넣기 훅 + 폭 상한(제외는 이유와 함께)', () => {
    const files = walk(SRC);
    expect(files.length, '스캔 재료가 비지 않았다').toBeGreaterThan(300);
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      const rel = path.relative(SRC, f);
      for (const hit of scan(fs.readFileSync(f, 'utf8'))) {
        seen += 1;
        if (!hit.ok && !EXEMPT[rel]) bad.push(`${rel}:${hit.line}`);
      }
    }
    expect(seen, '가드가 실제로 자리를 보고 있다(목차 · 문서 담당 · 트리 메뉴 등)').toBeGreaterThanOrEqual(7);
    expect(bad).toEqual([]);
  });
});
