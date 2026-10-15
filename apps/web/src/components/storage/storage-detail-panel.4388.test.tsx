// @vitest-environment jsdom
//
// [SID:4388] The detail panel's «상세 · 사용처» switch showed the chosen one only by its underline. It now uses the shared tabs
// (@/components/ui/tabs · base-ui): role="tab" with aria-selected, and arrow keys · Home/End move the selection.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StorageDetailPanel } from './storage-detail-panel';
import koMessages from '../../../messages/ko.json';
import type { Asset } from '@/lib/storage/types';

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

const ASSET: Asset = {
  id: 'a1',
  org_id: 'o1',
  project_id: 'p1',
  folder_id: null,
  container: 'assets',
  object_path: 'o1/a1.png',
  name: 'design.png',
  content_type: 'image/png',
  size_bytes: 2048,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  created_by: null,
  source_links: [],
};

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <StorageDetailPanel asset={ASSET} folderLabel={null} onDownload={vi.fn()} onRequestDelete={vi.fn()} />
      </NextIntlClientProvider>,
    );
  });
  // The shared tabs (base-ui) register their tabs in an effect after the first render — a click in that same tick is ignored.
  // Let it settle, as a real browser does before anyone can click.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function tabs() {
  return Array.from(container.querySelectorAll('[role="tab"]')).map((el) => `${el.textContent?.trim()}:${el.getAttribute('aria-selected')}`);
}

function panelFacts(root: ParentNode) {
  // Each tab points at its panel (aria-controls) and the rendered panel is named by the chosen tab and is a focus stop.
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  const chosen = tabs.find((t) => t.getAttribute('aria-selected') === 'true')!;
  return {
    panels: panels.length,
    namedByChosenTab: panels[0]?.getAttribute('aria-labelledby') === chosen.id,
    chosenControlsIt: chosen.getAttribute('aria-controls') === panels[0]?.id,
    focusable: panels[0]?.tabIndex === 0,
  };
}

describe('[SID:4388] StorageDetailPanel tabs announce the chosen tab', () => {
  it('«상세» starts selected; clicking «사용처» (with its count) moves aria-selected', async () => {
    await mount();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs()).toEqual(['상세:true', '사용처0:false']);

    const usage = Array.from(container.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.includes('사용처')) as HTMLElement;
    await act(async () => { usage.click(); });
    expect(tabs()).toEqual(['상세:false', '사용처0:true']);
  });

  it('arrow keys move the selection (and Home goes back to the first tab)', async () => {
    await mount();
    const tab = (i: number) => container.querySelectorAll<HTMLElement>('[role="tab"]')[i];
    await act(async () => { tab(0).focus(); tab(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(tabs()).toEqual(['상세:false', '사용처0:true']);
    expect(document.activeElement).toBe(tab(1));

    await act(async () => { tab(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(tabs()).toEqual(['상세:true', '사용처0:false']);
  });

  it('the body is the tab panel of the chosen tab (named by it · a focus stop) and follows the choice', async () => {
    await mount();
    const full = { panels: 1, namedByChosenTab: true, chosenControlsIt: true, focusable: true };
    expect(panelFacts(container)).toEqual(full);
    expect(container.querySelector('[role="tabpanel"]')!.textContent).toContain(koMessages.storage.metaFormat);
    // The shared panel's text-sm set a smaller line-height than the inherited one and pulled each meta row up ~1px (Yuna's
    // real-build diff). The panel inherits both instead.
    const panelClass = container.querySelector('[role="tabpanel"]')!.className.split(/\s+/);
    expect(panelClass).not.toContain('text-sm');
    expect(panelClass).toEqual(expect.arrayContaining(['text-[length:inherit]', 'leading-[inherit]']));

    const usage = Array.from(container.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.includes('사용처')) as HTMLElement;
    await act(async () => { usage.click(); });
    expect(panelFacts(container)).toEqual(full);
    expect(container.querySelector('[role="tabpanel"]')!.textContent).not.toContain(koMessages.storage.metaFormat);
  });
});
