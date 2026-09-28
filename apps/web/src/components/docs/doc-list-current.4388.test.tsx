// @vitest-environment jsdom
//
// [SID:4388] The doc lists in the sidebar (auto groups · search results · recents) showed the open doc only by colour. The open
// doc's button now carries aria-current="true" and the others carry none, so a screen reader says which one is open.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocAutoGroups } from './doc-auto-groups';
import { DocSearchResults } from './doc-search-results';
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
  { id: '1', slug: 'policy-a', title: '제목-1', parent_id: null, icon: null },
  { id: '2', slug: 'policy-b', title: '제목-2', parent_id: null, icon: null },
];

function docButton(title: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(title));
  if (!button) throw new Error(`no button for ${title}`);
  return button;
}

function currentTitles(): string[] {
  return Array.from(container.querySelectorAll('[aria-current]')).map((el) => `${el.getAttribute('aria-current')}:${el.textContent}`);
}

const AUTO_LABELS = {
  inFolderLabel: '폴더에 담김',
  looseAtRootLabel: '폴더 밖',
  thisMonthLabel: '이번 달',
  lastMonthLabel: '지난 달',
  olderLabel: '이전',
  unknownDateLabel: '날짜 없음',
  moreLabel: (count: number) => `${count}개 더`,
};

// A group forms from three docs sharing a slug prefix.
const GROUPED = [...DOCS, { id: '3', slug: 'policy-c', title: '제목-3', parent_id: null, icon: null }];

describe('[SID:4388] doc lists mark the open doc with aria-current', () => {
  it('auto groups: only the open doc is current, and it follows selectedSlug', async () => {
    const render = (selectedSlug: string | null) =>
      root.render(<DocAutoGroups docs={GROUPED} selectedSlug={selectedSlug} onSelect={() => {}} {...AUTO_LABELS} />);
    await act(async () => { render('policy-b'); });
    await act(async () => { docButton('POLICY').click(); });

    expect(docButton('제목-2').getAttribute('aria-current')).toBe('true');
    expect(docButton('제목-1').hasAttribute('aria-current')).toBe(false);

    await act(async () => { render('policy-a'); });
    expect(currentTitles()).toEqual(['true:제목-1']);

    await act(async () => { render(null); });
    expect(currentTitles()).toEqual([]);
  });

  it('search results: only the open doc is current, and it follows selectedSlug', async () => {
    const render = (selectedSlug: string | null) =>
      root.render(
        <DocSearchResults
          results={DOCS}
          loading={false}
          selectedSlug={selectedSlug}
          onSelect={() => {}}
          loadingLabel="…"
          noResultsLabel="없음"
          resultCountLabel={(n) => `${n}건`}
          cap={50}
        />,
      );
    await act(async () => { render('policy-a'); });
    expect(docButton('제목-1').getAttribute('aria-current')).toBe('true');
    expect(docButton('제목-2').hasAttribute('aria-current')).toBe(false);

    await act(async () => { render('policy-b'); });
    expect(docButton('제목-2').getAttribute('aria-current')).toBe('true');
    expect(docButton('제목-1').hasAttribute('aria-current')).toBe(false);
  });

  it('recents: only the open doc is current, and a doc not in recents marks none', async () => {
    const render = (selectedSlug: string | null) =>
      root.render(
        <RecentsSection
          recentSlugs={['policy-a', 'policy-b']}
          docs={DOCS}
          selectedSlug={selectedSlug}
          onSelect={() => {}}
          label="최근"
          emptyLabel="없음"
        />,
      );
    await act(async () => { render('policy-b'); });
    expect(currentTitles()).toEqual(['true:제목-2']);

    await act(async () => { render('elsewhere'); });
    expect(currentTitles()).toEqual([]);
  });
});
