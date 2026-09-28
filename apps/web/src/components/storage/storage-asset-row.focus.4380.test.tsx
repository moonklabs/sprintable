// @vitest-environment jsdom
//
// [SID:4380 · PO 10:50Z] 파일 목록 행 초점은 제품 링(안쪽 · -outline-offset-2) — 배경만 바꾸던 초점(outline-none + focus-visible:bg-muted/55)은
// 대비가 낮아 안 보였고, 고른 행의 고름 색(bg-info/10)을 덮었다. 폴더 나무 행과 같은 규칙(storage-folder-tree.4380.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StorageAssetRow } from './storage-asset-row';

vi.mock('./storage-uploader-avatar', () => ({ StorageUploaderAvatar: () => <span data-testid="uploader-avatar" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const asset = {
  id: 'a1', name: '분기 보고서 최종본.pdf', content_type: 'application/pdf', size_bytes: 2048, folder_id: 'f1', source_links: [],
  created_by: { id: 'm1', name: '업로더' }, updated_at: '2026-09-25T00:00:00Z', created_at: '2026-09-25T00:00:00Z',
};

describe('파일 목록 행 초점([SID:4380])', () => {
  it.each([true, false])('selected=%s — 제품 링(안쪽) · 링을 끄거나 초점 배경으로 덮지 않음 · 고른 행은 고름 색 유지', async (selected) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          {/* @ts-expect-error — 테스트 표본(필요 필드만) */}
          <StorageAssetRow asset={asset} selected={selected} folderLabel="회의록" onSelect={() => {}} onDelete={() => {}} onDownload={() => {}} />
        </NextIntlClientProvider>,
      );
    });
    const row = container.querySelector<HTMLElement>('[role="button"][tabindex="0"]')!;
    const cls = row.className.split(/\s+/);
    expect(cls).toContain('focus-visible:-outline-offset-2');
    expect(cls).not.toContain('outline-none');
    expect(cls.some((c) => c.startsWith('focus-visible:bg-'))).toBe(false);
    expect(cls.includes('bg-info/10')).toBe(selected);
  });
});
