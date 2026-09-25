// story #4308(유나 · PO 10:42Z) — 드롭다운 메뉴 안의 스크롤 칸(`overflow-*-auto`)은 탭 순서에서 뺀다(`tabIndex={-1}`). 크롬은 넘치는 스크롤 칸을
// 키보드 초점 대상으로 만들어, 메뉴를 포인터로 열고 Tab 하면 역할 · 이름 없는 칸에 한 번 멈췄다(담당자 필터). 항목은 검색칸 ↓ · 메뉴 화살표로 간다.
// 이 가드는 src 전수를 소스로 잡는다(렌더 속성은 kanban-board.test.tsx가 잰다).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx$/.test(name) && !name.includes('.test.')) out.push(p);
  }
  return out;
}

/** 메뉴 안 여는 태그 중 스크롤(`overflow-auto` · `overflow-y-auto` · `overflow-x-auto`)인데 `tabIndex={-1}`이 없는 수. */
export function tabbableScrollRegionsInsideMenus(src: string): number {
  let n = 0;
  for (const m of src.matchAll(/<DropdownMenu(Sub)?Content[\s\S]*?<\/DropdownMenu\1Content>/g)) {
    for (const tag of m[0].matchAll(/<[a-zA-Z][^<>]*?\boverflow-(?:[xy]-)?auto\b[^<>]*?>/g)) {
      if (!/tabIndex=\{-1\}/.test(tag[0])) n += 1;
    }
  }
  return n;
}

describe('드롭다운 메뉴 안 스크롤 칸은 탭 순서 밖(story #4308)', () => {
  it('⭐src 전수 — 메뉴 안 스크롤 칸은 모두 tabIndex={-1}', () => {
    const hits = files(SRC)
      .map((f) => [path.relative(SRC, f), tabbableScrollRegionsInsideMenus(readFileSync(f, 'utf8'))] as const)
      .filter(([, n]) => n > 0);
    expect(hits).toEqual([]);
  });

  it('양성대조 — 메뉴 안 tabIndex 없는 스크롤 칸은 잡고 · 있거나 메뉴 밖이면 안 잡는다', () => {
    expect(tabbableScrollRegionsInsideMenus('<DropdownMenuContent><div className="max-h-40 overflow-y-auto">x</div></DropdownMenuContent>')).toBe(1);
    expect(tabbableScrollRegionsInsideMenus('<DropdownMenuSubContent><div className="overflow-auto">x</div></DropdownMenuSubContent>')).toBe(1);
    expect(tabbableScrollRegionsInsideMenus('<DropdownMenuContent><div className="overflow-y-auto" tabIndex={-1}>x</div></DropdownMenuContent>')).toBe(0);
    expect(tabbableScrollRegionsInsideMenus('<div className="overflow-y-auto">x</div>')).toBe(0);
  });
});
