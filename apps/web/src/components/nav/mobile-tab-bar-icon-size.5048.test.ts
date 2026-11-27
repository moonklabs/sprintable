// story 5048 ④-③ (PO 11-27) — 아래 탭 막대의 아이콘은 단계 토큰(`size-ds-icon-lg`)만 쓰고, 선 굵기는 집안 기본(2)이다.
// 되돌리면(`size-[22px]` · `size={22}` · 선 굵기 속성) RED. 이 파일의 «모든» `<Icon …>` 여는 태그를 본다(첫 하나만 X — codex 지적).
// nav/* 나머지는 민 몫이라 이 파일 하나만 본다(채팅 가드 `styles/icon-size-steps.5048.test.ts`가 영역 단위 — 합칠 때 FILES로 옮긴다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, 'mobile-tab-bar.tsx'), 'utf8');
const tags = [...src.matchAll(/<Icon\b[^>]*>/g)].map((m) => m[0]);

describe('아래 탭 막대 아이콘 — 5048 ④-③', () => {
  it('⭐아이콘 태그가 있고 전부 단계 토큰 크기를 쓴다', () => {
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toContain('size-ds-icon-lg');
  });
  it('⭐직접 크기(size-N · size-[…] · h-N · w-N · size={…} · width/height)와 선 굵기 속성 0', () => {
    for (const t of tags) {
      const bare = t.replace(/size-ds-icon-(?:sm|md|lg)/g, '');
      expect(bare).not.toMatch(/(?<![\w:-])(?:size|h|w)-(?:\d|\[)/);
      expect(bare).not.toMatch(/\b(?:size|width|height)=\{/);
    }
    expect(src).not.toMatch(/stroke-?[Ww]idth/);
  });
});
