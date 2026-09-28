// @vitest-environment jsdom
//
// [SID:4388] The detail panel's «상세 · 사용처» switch showed the chosen one only by its underline. It is now a tablist: each
// button is role="tab" with aria-selected, so a screen reader says «tab, selected».
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

function tabs() {
  return Array.from(container.querySelectorAll('[role="tab"]')).map((el) => `${el.textContent?.trim()}:${el.getAttribute('aria-selected')}`);
}

describe('[SID:4388] StorageDetailPanel tabs announce the chosen tab', () => {
  it('«상세» starts selected; clicking «사용처» (with its count) moves aria-selected', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <StorageDetailPanel asset={ASSET} folderLabel={null} onDownload={vi.fn()} onRequestDelete={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs()).toEqual(['상세:true', '사용처0:false']);

    const usage = Array.from(container.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.includes('사용처')) as HTMLElement;
    await act(async () => { usage.click(); });
    expect(tabs()).toEqual(['상세:false', '사용처0:true']);
  });
});
