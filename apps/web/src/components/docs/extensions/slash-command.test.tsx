import { describe, expect, it } from 'vitest';
import {
  buildSlashMenuCategories,
  calculatePopupPosition,
  createSlashCommandExtension,
  type SlashMenuStrings,
} from './slash-command';
import enMessages from '../../../../messages/en.json';
import koMessages from '../../../../messages/ko.json';

// ---------------------------------------------------------------------------
// calculatePopupPosition — pure unit tests
// ---------------------------------------------------------------------------

describe('calculatePopupPosition', () => {
  const VIEWPORT_W = 1024;
  const VIEWPORT_H = 768;

  function makeRect(partial: Partial<DOMRect>): DOMRect {
    return {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...partial,
    } as DOMRect;
  }

  it('positions below the caret when there is sufficient space below', () => {
    // Caret at y=100, plenty of space below
    const rect = makeRect({ top: 100, bottom: 120, left: 50 });
    const { top, left } = calculatePopupPosition(rect, 200, 200, VIEWPORT_W, VIEWPORT_H);

    // top = bottom + gap = 120 + 4 = 124
    expect(top).toBe(124);
    // left = rect.left clamped (50 + 200 < 1024, no clamp needed)
    expect(left).toBe(50);
  });

  it('flips above the caret when space below is insufficient', () => {
    // Caret near the bottom: bottom=700, viewport height=768 → only 68px below
    // Space above: top=680 → 680-8=672px above
    const rect = makeRect({ top: 680, bottom: 700, left: 50 });
    const popupHeight = 256;
    const { top } = calculatePopupPosition(rect, popupHeight, 200, VIEWPORT_W, VIEWPORT_H);

    // Should open above: top = rect.top - gap - height = 680 - 4 - 256 = 420
    expect(top).toBe(420);
  });

  it('stays below when both spaces are equal — prefers below', () => {
    // Symmetric position: caret at vertical midpoint
    const rect = makeRect({ top: 380, bottom: 400, left: 50 });
    const popupHeight = 200;
    // spaceBelow = 768 - 400 - 8 = 360, spaceAbove = 380 - 8 = 372
    // spaceBelow < spaceAbove, BUT spaceBelow (360) >= popupHeight (200) → open below
    const { top } = calculatePopupPosition(rect, popupHeight, 200, VIEWPORT_W, VIEWPORT_H);
    expect(top).toBe(404); // 400 + 4
  });

  it('clamps top so popup does not extend below the viewport', () => {
    // Caret at y=750, space below = 768 - 750 - 8 = 10, space above = 730 - 8 = 722
    // Should flip above: top = 730 - 4 - 256 = 470
    const rect = makeRect({ top: 730, bottom: 750, left: 50 });
    const { top } = calculatePopupPosition(rect, 256, 200, VIEWPORT_W, VIEWPORT_H);
    expect(top).toBe(470);
  });

  it('clamps top to VIEWPORT_MARGIN when popup is taller than space above', () => {
    // Caret very near the top: top=20, bottom=40 → space above = 20-8=12 < popupHeight=256
    // Open below: top = 40 + 4 = 44, fine
    const rect = makeRect({ top: 20, bottom: 40, left: 50 });
    const { top } = calculatePopupPosition(rect, 256, 200, VIEWPORT_W, VIEWPORT_H);
    expect(top).toBe(44);
  });

  it('clamps left so popup does not overflow the right edge', () => {
    // Caret near the right edge: left=900, popupWidth=200 → would overflow
    const rect = makeRect({ top: 100, bottom: 120, left: 900 });
    const { left } = calculatePopupPosition(rect, 200, 200, VIEWPORT_W, VIEWPORT_H);
    // max left = 1024 - 200 - 8 = 816
    expect(left).toBe(816);
  });

  it('clamps left to VIEWPORT_MARGIN when caret is at x=0', () => {
    const rect = makeRect({ top: 100, bottom: 120, left: 0 });
    const { left } = calculatePopupPosition(rect, 200, 200, VIEWPORT_W, VIEWPORT_H);
    expect(left).toBe(8);
  });

  it('handles narrow viewport (mobile) without overflowing', () => {
    const MOBILE_W = 375;
    const MOBILE_H = 667;
    const rect = makeRect({ top: 100, bottom: 120, left: 10 });
    const { top, left } = calculatePopupPosition(rect, 256, 240, MOBILE_W, MOBILE_H);

    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 256).toBeLessThanOrEqual(MOBILE_H);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 240).toBeLessThanOrEqual(MOBILE_W);
  });
});

// ---------------------------------------------------------------------------
// createSlashCommandExtension / buildSlashMenuCategories — story ab2fd813(#2028)
// story #3782 — module-scope 상수 slashMenuCategories/defaultSlashItems/
// SlashCommandExtension(자기 테스트 외 소비처 0)를 걷으며, 이 상수들만 보던 assertion을
// 라이브 경로(buildSlashMenuCategories/createSlashCommandExtension)의 출력으로 옮겼다.
// ---------------------------------------------------------------------------

// raw messages/{ko,en}.json nest each item description one level deeper
// (`items.<key>.description`) than the flat `SlashMenuStrings` interface —
// doc-editor.tsx's `tSlash('items.<key>.description')` calls flatten that away.
// This helper mirrors the exact same flattening so the test exercises the real shape.
interface RawSlashMenuMessages {
  categories: SlashMenuStrings['categories'];
  items: Record<keyof SlashMenuStrings['items'], { description: string }>;
  embedPrompt: string;
  mermaidDefault: { start: string; end: string };
  toggleDefaultTitle: string;
}

function stringsFromMessages(messages: { docs: { slashMenu: RawSlashMenuMessages } }): SlashMenuStrings {
  const raw = messages.docs.slashMenu;
  const items = Object.fromEntries(
    Object.entries(raw.items).map(([key, value]) => [key, value.description]),
  ) as SlashMenuStrings['items'];
  return {
    categories: raw.categories,
    items,
    embedPrompt: raw.embedPrompt,
    mermaidDefault: raw.mermaidDefault,
    toggleDefaultTitle: raw.toggleDefaultTitle,
  };
}

const KOREAN_RE = /[가-힣]/;

const enStrings = stringsFromMessages(enMessages as unknown as { docs: { slashMenu: RawSlashMenuMessages } });
const koStrings = stringsFromMessages(koMessages as unknown as { docs: { slashMenu: RawSlashMenuMessages } });
const enCategories = buildSlashMenuCategories(enStrings);
const koCategories = buildSlashMenuCategories(koStrings);

// story #3782 — 이전엔 defaultSlashItems(module-scope ko 고정 상수, 자기 테스트 외
// 소비처 0)의 항목 형(title/icon/command)을 직접 쟀다. 그 상수를 걷으며 같은 불변식을
// 라이브 경로의 출력(buildSlashMenuCategories)으로 옮긴다 — title은 로케일 무관 검색
// 키라 en/ko 어느 쪽으로 재도 동일(아래 'item titles stay identical' 테스트가 그 불변식
// 자체를 고정).
describe('buildSlashMenuCategories(strings) — item shape (story #3782, defaultSlashItems 후속)', () => {
  const items = enCategories.flatMap((c) => c.items);

  it('includes expected block types (title = locale-invariant search key)', () => {
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Heading 1');
    expect(titles).toContain('Bullet List');
    expect(titles).toContain('Code Block');
    expect(titles).toContain('Table');
    expect(titles).toContain('Callout');
  });

  it('each item has a non-empty title, icon, and command function', () => {
    for (const item of items) {
      expect(item.title.length).toBeGreaterThan(0);
      // icon is an FC<{ className?: string }> (lucide component), not a string — assert it exists
      expect(item.icon).toBeTruthy();
      expect(typeof item.command).toBe('function');
    }
  });
});

describe('buildSlashMenuCategories — EN strings carry no Korean leakage', () => {
  it('every category label is Korean-free', () => {
    for (const cat of enCategories) {
      expect(KOREAN_RE.test(cat.label)).toBe(false);
    }
  });

  it('every item description is Korean-free', () => {
    for (const cat of enCategories) {
      for (const item of cat.items) {
        expect(KOREAN_RE.test(item.description)).toBe(false);
      }
    }
  });

  // story #3782 — 이전엔 module-scope 상수 slashMenuCategories(ko 고정)와 비교했으나 그
  // 상수 자체가 테스트 전용 죽은 export라 걷었다. title이 로케일 무관 검색 키라는 게 본래
  // 불변식이므로, en/ko 두 로케일 결과를 서로 비교해도 같은 불변식을 고정할 수 있다.
  it('item titles stay identical across locales (locale-invariant search key)', () => {
    const enTitles = enCategories.flatMap((c) => c.items.map((i) => i.title));
    const koTitles = koCategories.flatMap((c) => c.items.map((i) => i.title));
    expect(enTitles).toEqual(koTitles);
  });

  it('produces the same category/item counts across locales', () => {
    expect(enCategories.length).toBe(koCategories.length);
    expect(enCategories.flatMap((c) => c.items).length).toBe(koCategories.flatMap((c) => c.items).length);
  });
});

// story #3782 — 이전엔 module-scope 상수 slashMenuCategories(i18n 이전 원본 한글 고정값)와
// 비교했으나 그 상수 자체가 테스트 전용 죽은 export라 걷었다. 아래 배열은 그 상수가 갖고
// 있던 정확한 값(2026-09-10 삭제 직전 실측, 카테고리·항목 순서 그대로)을 이 테스트에 그대로
// 얼려 둔 것 — ko.json이 조용히 다른 뜻으로 바뀌는 것(오타·의미변형)을 계속 잡아낸다.
const KO_DESCRIPTIONS_FROZEN_AT_MIGRATION = [
  '큰 제목', '중간 제목', '작은 제목',
  '순서 없는 목록', '순서 있는 목록', '체크리스트',
  '코드 블록', '인용구', '강조 박스', '표 삽입',
  '이미지 삽입', '파일 첨부', '외부 URL 임베드', '다이어그램 삽입',
  '2단/3단 컬럼 레이아웃', 'LaTeX 블록 수식', 'LaTeX 인라인 수식', '접기/펼치기 블록', '다른 문서 임베드', '구분선',
];

describe('buildSlashMenuCategories — KO strings still carry the original Korean copy', () => {
  it('description text matches the pre-i18n golden copy 1:1 (no meaning drift)', () => {
    const koDescriptions = koCategories.flatMap((c) => c.items.map((i) => i.description));
    expect(koDescriptions).toEqual(KO_DESCRIPTIONS_FROZEN_AT_MIGRATION);
  });
});

describe('createSlashCommandExtension(strings)', () => {
  it('builds an Extension named "slashCommand" regardless of injected strings', () => {
    const ext = createSlashCommandExtension(enStrings);
    expect(ext.name).toBe('slashCommand');
  });

  it('filters suggestion items by title (English search key), not by localized description', () => {
    const ext = createSlashCommandExtension(enStrings);
    const options = ext.options as { suggestion: { items: (arg: { query: string }) => { title: string }[] } };
    const matches = options.suggestion.items({ query: 'heading' });
    expect(matches.map((m) => m.title)).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
  });
});
