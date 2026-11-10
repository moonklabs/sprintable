// story #4885 PR 3 — 막대 아이콘 표(rail-icons.ts)의 완전성 · 막대 소스의 «옛 색 클래스 0».
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS } from '@/components/ds/icon-paths';
import { ALL_SCREENS_ITEM, CHAT_CENTER_ITEM, resolveNavGroups } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS } from '@/lib/nav-v3-destinations';
import { RAIL_ICON_BY_ITEM_ID } from './rail-icons';

// 막대가 그리는 항목 = 구역 항목(데스크톱 앱 포함) + 대화 카드 + 전체. 새 항목이 생겼는데 표에 줄이 없으면 아이콘이 «undefined»라 여기서 빨개진다.
const railItemIds = () => {
  const flags = { ...DEFAULT_NAV_V3_FLAGS, desktopDownloadEnabled: true };
  return [...resolveNavGroups(flags).flatMap((g) => g.items.map((i) => i.id)), CHAT_CENTER_ITEM.id, ALL_SCREENS_ITEM.id];
};

describe('막대 아이콘 표', () => {
  it('⭐막대 · 옆 목록에 그려지는 모든 항목에 글리프 이름이 있다', () => {
    const missing = railItemIds().filter((id) => !(id in RAIL_ICON_BY_ITEM_ID));
    expect(missing).toEqual([]);
  });
  it('표의 모든 글리프는 ds 아이콘 모음(icon-paths)에 실제로 있다', () => {
    const bad = Object.entries(RAIL_ICON_BY_ITEM_ID).filter(([, g]) => !(g in ICON_PATHS));
    expect(bad).toEqual([]);
  });
  it('막대에만 있는 단추(조직 · 검색 · 목록 칸 단추 · 계정)도 표에 있다', () => {
    for (const id of ['org', 'search', 'list-column-toggle', 'account']) expect(RAIL_ICON_BY_ITEM_ID[id], id).toBeTruthy();
  });
});

// «별칭 없이 따로» (UI-3 규칙): 새 부품 · 화면은 `ds-*` 이름만. components/ds 가드의 같은 정규식을 막대 소스에 건다.
const OLD_COLOR = /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|shadow)-(?:background|foreground|muted(?:-foreground)?|card(?:-foreground)?|primary(?:-foreground)?|secondary(?:-foreground)?|accent(?:-foreground)?|destructive|popover|input|ring|border|success|warning|info|proof-[\w-]+|brand(?:-[\w-]+)?|sidebar(?:-[\w-]+)?)(?![\w-])/;
const code = (file: string) => readFileSync(join(__dirname, file), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');

describe('막대는 ds 이름만 쓴다', () => {
  it('nav-rail.tsx에 옛 색 클래스가 없다', () => {
    expect(code('nav-rail.tsx').match(new RegExp(OLD_COLOR, 'g')) ?? []).toEqual([]);
  });
  it('rail-account.tsx의 «계정» 아이콘 단추(트리거)에 옛 색 클래스가 없다 — 팝오버 안은 길잡이에서 옮긴 기존 부품 그대로라 제외', () => {
    const src = code('rail-account.tsx');
    const trigger = src.slice(src.indexOf('<PopoverTrigger'), src.indexOf('</PopoverTrigger>'));
    expect(trigger.length).toBeGreaterThan(50);
    expect(trigger.match(new RegExp(OLD_COLOR, 'g')) ?? []).toEqual([]);
  });
  it('막대 소스는 lucide-react를 더 이상 부르지 않는다', () => {
    expect(code('nav-rail.tsx')).not.toContain('lucide-react');
    expect(code('rail-account.tsx')).not.toContain('lucide-react');
  });
});
