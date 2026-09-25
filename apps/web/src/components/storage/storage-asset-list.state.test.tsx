// @vitest-environment jsdom
// story #4277(CI 36138526074) — e2e가 행 출현을 기다리다(자산 0) 테스트 제한시간까지 걸렸다. 목록 몸통이 지금 상태를 싣고(data-state),
// e2e는 «불러오는 중»을 벗어나길 짧게 기다려 한 번 읽는다 — 그 상태 값이 실제 화면 갈래와 맞는지 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StorageAssetList } from './storage-asset-list';
import type { Asset } from '@/lib/storage/types';

vi.mock('./storage-uploader-avatar', () => ({ StorageUploaderAvatar: () => <span data-testid="uploader-avatar" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const ASSET = {
  id: 'a1', name: '분기 보고서.pdf', content_type: 'application/pdf', size_bytes: 2048, folder_id: null, source_links: [],
  created_by: { id: 'm1', name: '업로더' }, updated_at: '2026-09-25T00:00:00Z', created_at: '2026-09-25T00:00:00Z',
} as unknown as Asset;

async function stateFor(opts: { loading?: boolean; error?: boolean; assets?: readonly Asset[] }): Promise<string | null> {
  const noop = () => {};
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <StorageAssetList
          assets={[...(opts.assets ?? [])]} viewMode="list" onViewModeChange={noop} search="" onSearchChange={noop} sort="date" onSortChange={noop}
          selectedAssetId={null} onSelectAsset={noop} onDeleteAsset={noop} onDownloadAsset={noop} onUploadFile={noop}
          resolveFolderLabel={() => null} loading={opts.loading ?? false} error={opts.error ?? false} onRetry={noop}
          isSearchActive={false} hasMore={false} loadingMore={false} onLoadMore={noop}
        />
      </NextIntlClientProvider>,
    );
  });
  return container.querySelector('[data-testid="storage-asset-list-body"]')?.getAttribute('data-state') ?? null;
}

describe('스토리지 목록 몸통 상태(data-state · story #4277 e2e 대기)', () => {
  it.each([
    ['불러오는 중', { loading: true, assets: [ASSET] }, 'loading'],
    ['실패', { error: true }, 'error'],
    ['자산 0', {}, 'empty'],
    ['자산 있음', { assets: [ASSET] }, 'rows'],
  ] as const)('%s → %s', async (_label, opts, expected) => {
    expect(await stateFor(opts)).toBe(expected);
  });

  it('«rows»일 때 e2e가 재는 행(이름 블록)이 실제로 있다 · «empty»면 없다', async () => {
    await stateFor({ assets: [ASSET] });
    expect(container.querySelector('[role="button"][aria-pressed] > div.min-w-0')).not.toBeNull();
    await stateFor({});
    expect(container.querySelector('[role="button"][aria-pressed] > div.min-w-0')).toBeNull();
  });
});
