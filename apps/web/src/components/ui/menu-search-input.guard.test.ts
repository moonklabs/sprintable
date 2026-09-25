// story #4306 — 드롭다운 메뉴(DropdownMenuContent) 안에 `autoFocus` 입력을 두지 않는다. 메뉴가 열릴 때 첫 항목으로 초점을 옮겨 `autoFocus`를
// 이기므로(입력이 타이프어헤드로 샘) 메뉴 안 검색칸은 MenuSearchInput으로 쓴다. 이 가드는 src 전수를 소스로 잡는다(렌더 동작은
// kanban-board.test.tsx «필터 메뉴를 열면 초점 = 검색칸»이 잰다).
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

export function autoFocusInsideMenus(src: string): number {
  let n = 0;
  // 까디르 QA(PO 10:06Z) — 하위 메뉴(DropdownMenuSubContent)도 같은 초점 관리라 같이 본다.
  for (const m of src.matchAll(/<DropdownMenu(Sub)?Content[\s\S]*?<\/DropdownMenu\1Content>/g)) {
    n += (m[0].match(/\bautoFocus\b/g) ?? []).length;
  }
  return n;
}

describe('드롭다운 메뉴 안 autoFocus 0(story #4306)', () => {
  it('⭐src 전수 — 메뉴 안 autoFocus 입력 0(검색칸은 MenuSearchInput)', () => {
    const hits = files(SRC)
      .map((f) => [path.relative(SRC, f), autoFocusInsideMenus(readFileSync(f, 'utf8'))] as const)
      .filter(([, n]) => n > 0);
    expect(hits).toEqual([]);
  });

  it('양성대조 — 메뉴 안 autoFocus는 잡고 메뉴 밖은 안 잡는다', () => {
    expect(autoFocusInsideMenus('<DropdownMenuContent><Input autoFocus value={q} /></DropdownMenuContent>')).toBe(1);
    expect(autoFocusInsideMenus('<Input autoFocus /><DropdownMenuContent><MenuSearchInput /></DropdownMenuContent>')).toBe(0);
    expect(autoFocusInsideMenus('<DropdownMenuSubContent><Input autoFocus /></DropdownMenuSubContent>')).toBe(1);
  });
});
