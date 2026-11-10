// story #4885 (UI-2 AC4 · 단축키 표시 정직) — 화면에 보이는 단축키마다 받는 키 처리가 있어야 한다. 없으면 RED.
// 되돌리면 RED: ① 표에 처리 없는 단축키를 올리면 ② 내비 항목에 kbdHint를 다시 달면(예: 일감 «B») ③ 표시하는 쪽의 관문(isRealShortcut)을 걷으면(팔레트 · 사이드바 소스 대조).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_SHORTCUTS, isRealShortcut } from './keyboard-shortcuts';
import { allNavItems } from './nav-config';

const SRC = join(__dirname, '..');

describe('REAL_SHORTCUTS — 표의 줄마다 받는 처리가 실제로 있다', () => {
  it('⭐각 줄의 처리 파일이 있고, keydown 처리와 그 이벤트 키가 그 파일에 실제로 있다', () => {
    expect(REAL_SHORTCUTS.length).toBeGreaterThan(0);
    for (const s of REAL_SHORTCUTS) {
      const file = join(SRC, s.handler);
      expect(existsSync(file), `${s.keys.join(' ')} → ${s.handler}`).toBe(true);
      const src = readFileSync(file, 'utf8');
      expect(src, `${s.handler}에 keydown 처리`).toMatch(/addEventListener\(\s*['"]keydown['"]/);
      expect(src, `${s.handler}가 이벤트 키 '${s.eventKey}'를 비교`).toContain(`'${s.eventKey}'`);
    }
  });

  it('지금 실제 단축키는 ⌘K(팔레트 열기) 하나뿐이다 — 늘릴 땐 키 처리를 먼저 만들고 이 표에 올린다', () => {
    expect(REAL_SHORTCUTS.map((s) => s.keys.join(' '))).toEqual(['⌘ K']);
  });
});

describe('isRealShortcut — 표시 관문', () => {
  it('표에 있는 조합만 참 · 받는 곳 없던 옛 표시(G I/B/M/A/S · B)는 거짓', () => {
    expect(isRealShortcut(['⌘', 'K'])).toBe(true);
    for (const keys of [['G', 'I'], ['G', 'B'], ['G', 'M'], ['G', 'A'], ['G', 'S'], ['B'], ['K'], []]) expect(isRealShortcut(keys), keys.join(' ')).toBe(false);
    expect(isRealShortcut(undefined)).toBe(false);
  });
});

describe('보이는 곳은 관문을 지난다', () => {
  it('⭐내비 항목의 kbdHint(사이드바가 그리는 단축키)는 전부 실제 단축키다 — 지금은 하나도 없다(일감 «B»는 받는 곳이 없어 걷었다)', () => {
    const hinted = allNavItems().filter((i) => i.kbdHint !== undefined);
    expect(hinted.filter((i) => !isRealShortcut([i.kbdHint!])).map((i) => `${i.id}:${i.kbdHint}`)).toEqual([]);
  });

  it('팔레트 · 사이드바 소스가 isRealShortcut 관문을 거쳐서만 단축키를 그린다', () => {
    const palette = readFileSync(join(SRC, 'components/command-palette/command-palette.tsx'), 'utf8');
    const sidebar = readFileSync(join(SRC, 'components/nav/app-sidebar.tsx'), 'utf8');
    expect(palette).toContain('isRealShortcut(NAV_ITEM_SHORTCUTS[item.id])');
    expect(sidebar).toContain('isRealShortcut([item.kbdHint])');
    // 표 자체도 비어 있다 — G 연타 처리가 생기기 전까진 표시 자료가 없다
    expect(palette).toContain('const NAV_ITEM_SHORTCUTS: Record<string, string[]> = {};');
  });
});
