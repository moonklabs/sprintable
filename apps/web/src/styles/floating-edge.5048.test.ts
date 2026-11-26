// story 5048 T0 ③a (PO 11-26) — 그림자를 정의 한 곳에서 none으로 한 뒤에도 «떠 있는 면»이 배경과 갈린다: 면 차이 또는 1px 선.
// 여섯: 드롭다운(ds Menu · ui DropdownMenu) · 팝오버(ui) · 대화상자(ds · ui) · 토스트(ds ToastCard) · 우클릭 메뉴(= ds Menu의 같은 면) · ⌘K 팔레트.
// 소스의 팝업 클래스 문자열을 읽어 «면 토큰 + 선(border 또는 ring-1, 알파 아님)»을 한 줄씩 확인하고, 선 토큰과 면의 대비(라이트 · 다크)가 눈에 보이는 선인지(≥ 1.3:1) 값으로 잰다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', 'components');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const css = readFileSync(join(__dirname, 'design-system.css'), 'utf8');

/** the className string literal of a floating popup: the first quoted string that carries the face token and `z-50`-style popup marks */
function popupClasses(src: string, face: RegExp, mark: RegExp): string {
  const found = [...src.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]!).filter((c) => face.test(c) && mark.test(c));
  if (!found.length) throw new Error(`popup class string not found for ${face} / ${mark}`);
  return found[0]!;
}
const FACE = /\b(?:bg-popover|bg-ds-surface-raised)\b/;
const edge = (c: string) => (/(?:^|\s)border(?:\s|$)/.test(c) && /\bborder-(?:ds-line|ds-line-control|proof-line-strong)\b/.test(c)) || (/(?:^|\s)ring-1(?:\s|$)/.test(c) && /\bring-(?:ds-line|ds-line-control|proof-line-strong)\b/.test(c));

describe('떠 있는 면 여섯 — 그림자 없이도 면 + 1px 선으로 갈린다 (story 5048 ③a)', () => {
  const surfaces: Array<[string, string, RegExp]> = [
    ['ds Menu(드롭다운 · 우클릭 메뉴 · ⌘K 밖 목록)', 'ds/menu.tsx', /overflow-y-auto/],
    ['ui DropdownMenu', 'ui/dropdown-menu.tsx', /overflow-y-auto/],
    ['ui Popover', 'ui/popover.tsx', /z-50/],
    ['ds Dialog', 'ds/dialog.tsx', /group\/dialog/],
    ['ui Dialog', 'ui/dialog.tsx', /group\/dialog/],
    ['⌘K 팔레트', 'command-palette/command-palette.tsx', /overflow-hidden/],
  ];
  it.each(surfaces)('⭐%s: 면(popover · raised) + 불투명 1px 선', (_n, file, mark) => {
    const c = popupClasses(read(file), FACE, mark);
    expect(FACE.test(c), c).toBe(true);
    expect(edge(c), `no 1px edge in: ${c}`).toBe(true);
    expect(c, 'the edge is an opaque token, not an alpha ring').not.toMatch(/(?:ring|border)-[\w-]+\/\d+/);
  });

  it('⭐토스트(ds ToastCard): 모든 종류가 border + 선 토큰 · 면은 raised 또는 의미 soft 면', () => {
    const src = read('ds/toast-card.tsx');
    expect(src).toMatch(/rounded-ds-panel border /);
    const boxes = [...src.matchAll(/box: '([^']+)'/g)].map((m) => m[1]!);
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    for (const b of boxes) expect(/\bborder-ds-[\w-]+(?:\/\d+)?\b/.test(b) && /\bbg-ds-[\w-]+\b/.test(b), b).toBe(true);
  });

  // 선 토큰이 면 위에서 눈에 보이는 선인지(대비 ≥ 1.3:1): 라이트 · 다크 값으로 계산(선이 «있는 척»만 하지 않게)
  const lum = (hex: string) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!; };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  const tokens = (sel: string) => { const m = css.match(new RegExp(`(?:^|\\n)${sel}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`)); return Object.fromEntries([...m![1]!.matchAll(/--ds-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1], x[2]!.toLowerCase()])) as Record<string, string>; };
  it.each([[':root', '라이트'], ['\\.dark', '다크']])('⭐%s(%s): line-strong은 raised 면 위에서 눈에 보이는 선(≥ 1.3:1) · line-control은 3:1', (sel) => {
    const t = tokens(sel);
    expect(ratio(t['line-strong']!, t['surface-raised']!)).toBeGreaterThanOrEqual(1.3);
    expect(ratio(t['line-control']!, t['surface-raised']!)).toBeGreaterThanOrEqual(3);
  });
});
