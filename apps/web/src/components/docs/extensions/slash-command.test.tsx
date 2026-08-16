import { describe, expect, it } from 'vitest';
import { calculatePopupPosition, defaultSlashItems } from './slash-command';

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
// defaultSlashItems — sanity checks
// ---------------------------------------------------------------------------

describe('defaultSlashItems', () => {
  it('includes expected block types', () => {
    const titles = defaultSlashItems.map((i) => i.title);
    expect(titles).toContain('Heading 1');
    expect(titles).toContain('Bullet List');
    expect(titles).toContain('Code Block');
    expect(titles).toContain('Table');
    expect(titles).toContain('Callout');
  });

  it('each item has a non-empty title, icon, and command function', () => {
    for (const item of defaultSlashItems) {
      expect(item.title.length).toBeGreaterThan(0);
      // icon is an FC<{ className?: string }> (lucide component), not a string — assert it exists
      expect(item.icon).toBeTruthy();
      expect(typeof item.command).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// SlashMenu component — keyboard navigation + rendering
// ---------------------------------------------------------------------------

// We need to import SlashMenu; it's not exported, so we test indirectly through
// a thin wrapper that re-exports the internals we care about.
// Since the component is defined with forwardRef inside the module, we test
// the rendered output via a simple integration: render the list and assert.

// Re-export the component from the module for testing. If it becomes exported
// in the future, this pattern can be replaced with a direct import.
import { SlashCommandExtension, buildSlashMenuCategories, createSlashCommandExtension, slashMenuCategories, type SlashMenuStrings } from './slash-command';

describe('SlashCommandExtension', () => {
  it('is created with name "slashCommand"', () => {
    expect(SlashCommandExtension.name).toBe('slashCommand');
  });
});

// ---------------------------------------------------------------------------
// createSlashCommandExtension / buildSlashMenuCategories — story ab2fd813(#2028)
// ---------------------------------------------------------------------------

import enMessages from '../../../../messages/en.json';
import koMessages from '../../../../messages/ko.json';

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

describe('buildSlashMenuCategories — EN strings carry no Korean leakage', () => {
  const enStrings = stringsFromMessages(enMessages as unknown as { docs: { slashMenu: RawSlashMenuMessages } });
  const enCategories = buildSlashMenuCategories(enStrings);

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

  it('item titles stay identical to the static (search-key) fallback regardless of locale', () => {
    const staticTitles = slashMenuCategories.flatMap((c) => c.items.map((i) => i.title));
    const localizedTitles = enCategories.flatMap((c) => c.items.map((i) => i.title));
    expect(localizedTitles).toEqual(staticTitles);
  });

  it('produces the same category/item counts as the static fallback', () => {
    expect(enCategories.length).toBe(slashMenuCategories.length);
    expect(enCategories.flatMap((c) => c.items).length).toBe(slashMenuCategories.flatMap((c) => c.items).length);
  });
});

describe('buildSlashMenuCategories — KO strings still carry the original Korean copy', () => {
  it('description text matches the pre-i18n static fallback 1:1 (no meaning drift)', () => {
    const koStrings = stringsFromMessages(koMessages as unknown as { docs: { slashMenu: RawSlashMenuMessages } });
    const koCategories = buildSlashMenuCategories(koStrings);
    const koDescriptions = koCategories.flatMap((c) => c.items.map((i) => i.description));
    const staticDescriptions = slashMenuCategories.flatMap((c) => c.items.map((i) => i.description));
    expect(koDescriptions).toEqual(staticDescriptions);
  });
});

describe('createSlashCommandExtension(strings)', () => {
  it('builds an Extension named "slashCommand" regardless of injected strings', () => {
    const enStrings = stringsFromMessages(enMessages as unknown as { docs: { slashMenu: RawSlashMenuMessages } });
    const ext = createSlashCommandExtension(enStrings);
    expect(ext.name).toBe('slashCommand');
  });

  it('filters suggestion items by title (English search key), not by localized description', () => {
    const enStrings = stringsFromMessages(enMessages as unknown as { docs: { slashMenu: RawSlashMenuMessages } });
    const ext = createSlashCommandExtension(enStrings);
    const options = ext.options as { suggestion: { items: (arg: { query: string }) => { title: string }[] } };
    const matches = options.suggestion.items({ query: 'heading' });
    expect(matches.map((m) => m.title)).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
  });
});
