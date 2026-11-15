// @vitest-environment jsdom
//
// story 4892 (UI-9 문서 목록 열, 첫 조각) — «최근» wears the ds parts: the heading is a ds SectionHeader (collapsible, with the count), each row is a
// ds ListRow that is itself the button. The behaviour stays: collapse flips `aria-expanded`, choosing a row calls `onSelect(slug)`, only the open doc
// carries `aria-current="page"`, a doc that is not in the list is skipped, and an empty list says the empty line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RecentsSection } from './recents-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const DOCS = [
  { id: '1', slug: 'policy-a', title: '제목-1', icon: null, status: 'draft' },
  { id: '2', slug: 'policy-b', title: '제목-2', icon: '📘', status: 'approved' },
];

async function mount(over: Partial<React.ComponentProps<typeof RecentsSection>> = {}) {
  const onSelect = vi.fn();
  await act(async () => {
    root.render(
      <RecentsSection recentSlugs={['policy-a', 'policy-b', 'gone']} docs={DOCS} selectedSlug="policy-b" onSelect={onSelect} label="최근" emptyLabel="없음" {...over} />,
    );
  });
  return onSelect;
}
const header = () => container.querySelector('[data-slot="ds-section-header"]') as HTMLElement | null;
const toggle = () => header()?.querySelector('button[aria-expanded]') as HTMLButtonElement | null;
const rows = () => Array.from(container.querySelectorAll('[data-slot="ds-list-row"]')) as HTMLElement[];

describe('RecentsSection — ds SectionHeader + ListRow (4892)', () => {
  it('the heading is a ds SectionHeader that names the list and counts the docs that exist (a missing slug is not counted)', async () => {
    await mount();
    expect(header()).not.toBeNull();
    expect(header()!.textContent).toContain('최근');
    expect(header()!.textContent).toContain('2');
    expect(header()!.querySelector('h2')).not.toBeNull();
  });

  it('the heading is level 2 (the sidebar sits before the page h1) and the rows use the ds compact density (36px, not the default 56) in the narrow rail', async () => {
    await mount();
    expect(header()!.querySelector('h2')).not.toBeNull();
    expect(header()!.querySelector('h3')).toBeNull();
    for (const r of rows()) {
      expect(r.getAttribute('data-density')).toBe('compact');
      const cls = r.className.split(/\s+/);
      expect(cls).toContain('min-h-ds-control');
      expect(cls).not.toContain('min-h-ds-row');
    }
  });

  it('every row is a ds ListRow that is the button itself; a slug that is not in the docs is skipped', async () => {
    await mount();
    expect(rows().length).toBe(2);
    for (const r of rows()) expect(r.tagName).toBe('BUTTON');
    expect(rows().map((r) => r.textContent)).toEqual(['제목-1', '📘제목-2']);
  });

  it('choosing a row calls onSelect with that doc\'s slug', async () => {
    const onSelect = await mount();
    await act(async () => { rows()[0]!.click(); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('policy-a');
  });

  it('only the open doc carries aria-current="page"', async () => {
    await mount({ selectedSlug: 'policy-b' });
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual([null, 'page']);
    await mount({ selectedSlug: 'elsewhere' });
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual([null, null]);
  });

  it('the open row is drawn selected (ds ListRow selected) and the others are not', async () => {
    await mount({ selectedSlug: 'policy-b' });
    expect(rows().map((r) => r.className.split(/\s+/).includes('bg-ds-surface-high'))).toEqual([false, true]);
  });

  it('slugs that match no doc at all give no count, not «0»', async () => {
    await mount({ recentSlugs: ['gone', 'also-gone'] });
    expect(header()!.textContent).toBe('최근');
    expect(rows().length).toBe(0);
  });

  it('the heading collapses and opens the list (aria-expanded follows)', async () => {
    await mount();
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { toggle()!.click(); });
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
    expect(rows().length).toBe(0);
    await act(async () => { toggle()!.click(); });
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(rows().length).toBe(2);
  });

  it('an empty list says the empty line and shows no count', async () => {
    await mount({ recentSlugs: [] });
    expect(container.textContent).toContain('없음');
    expect(rows().length).toBe(0);
    expect(header()!.textContent).toBe('최근');
  });

  it('the status dot and the doc icon are kept on the row', async () => {
    await mount();
    expect(rows()[0]!.querySelector('[data-icon="description"]')).not.toBeNull();   // no icon → the ds document glyph
    expect(rows()[1]!.textContent).toContain('📘');                                  // an emoji icon stays
    expect(rows()[0]!.querySelector('span.rounded-full')).not.toBeNull();            // the status dot
    expect(rows()[0]!.querySelector('span.truncate.min-w-0')?.textContent).toBe('제목-1');   // a long title is cut, not wrapped
  });
});
