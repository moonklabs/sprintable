// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StorageDeleteDialog } from './storage-delete-dialog';
import type { Asset, AssetSourceLink } from '@/lib/storage/types';

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
  vi.unstubAllGlobals();
});

function makeAsset(sourceLinkCount: number): Asset {
  const source_links: AssetSourceLink[] = Array.from({ length: sourceLinkCount }, (_, i) => ({
    type: 'story',
    id: `story-${i}`,
    title: `사용처 ${i}`,
    deeplink: { story_id: `story-${i}` },
  }));
  return {
    id: 'asset-1',
    org_id: 'org-1',
    project_id: 'proj-1',
    folder_id: null,
    container: 'c',
    object_path: 'p',
    name: 'design.png',
    content_type: 'image/png',
    size_bytes: 1024,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    created_by: null,
    source_links,
  };
}

function renderDialog(asset: Asset) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages}>
        <StorageDeleteDialog asset={asset} open onOpenChange={() => {}} onDeleted={() => {}} />
      </NextIntlClientProvider>,
    );
  });
}

// story #2525 — footer(삭제 CTA)가 본문(usage list) 스크롤에 밀려 화면 밖으로 나가던 결함.
// jsdom은 실제 overflow/clipping을 계산하지 않으므로, footer가 스크롤 영역 밖(shrink-0)에
// 구조적으로 고정돼 있는지 + body가 스스로 스크롤(overflow-y-auto)하는지를 클래스 계약으로 고정한다.
// 실제 시각 확인(usage list가 viewport를 넘겨도 버튼이 보이는지)은 라이브 QA 몫.
describe('StorageDeleteDialog — #2525 footer sticky', () => {
  // base-ui Dialog는 document.body에 portal 렌더된다(container 안이 아님) — document에서 쿼리.
  it('usage list가 길어도 footer가 스크롤 영역 밖(shrink-0)에 고정된다', () => {
    renderDialog(makeAsset(50));
    const deleteButton = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent === '삭제');
    expect(deleteButton).toBeTruthy();
    const footer = deleteButton?.closest('div.border-t');
    expect(footer?.className).toContain('shrink-0');
  });

  it('body 영역이 자체 overflow-y-auto로 내부 스크롤한다(footer와 분리)', () => {
    renderDialog(makeAsset(50));
    const body = Array.from(document.querySelectorAll('div'))
      .find((d) => d.className.includes('leading-[1.55]'));
    expect(body?.className).toContain('overflow-y-auto');
    expect(body?.className).toContain('min-h-0');
    expect(body?.className).toContain('flex-1');
  });

  it('짧은 usage list 케이스도 회귀 없이 렌더된다(기존 동작 유지)', () => {
    renderDialog(makeAsset(1));
    const deleteButton = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent === '삭제');
    expect(deleteButton).toBeTruthy();
  });

  it('usage 0건이면 impact 배너가 안 뜬다(기존 동작 유지)', () => {
    renderDialog(makeAsset(0));
    expect(document.body.textContent).not.toContain('곳에서 사용 중');
  });
});
