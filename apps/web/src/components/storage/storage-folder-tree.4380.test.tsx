// @vitest-environment jsdom
//
// [SID:4380] 하위 폴더 펼침이 마우스 전용 화살표(span onClick)에만 있어 키보드로 못 펼쳤고 상태도 안 알렸다 →
// 행이 aria-expanded를 싣고 → / ← 로 펼치고 접는다 · 화살표 span은 aria-hidden(마우스 전용 모양).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StorageFolderTree } from './storage-folder-tree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => { store.clear(); } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const FOLDERS = [
  { id: 'f-parent', name: '설계', parent_id: null, project_id: 'p1' },
  { id: 'f-child', name: '화면 시안', parent_id: 'f-parent', project_id: 'p1' },
];

describe('[SID:4380] 폴더 나무 — 펼침 상태 · 키보드로 펼치고 접기', () => {
  it('자식 있는 행은 aria-expanded — → 로 펼침(자식 보임) · ← 로 접힘 · 화살표 span은 aria-hidden', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <StorageFolderTree folders={FOLDERS} selectedFolderId={null} onSelectFolder={() => {}} projectId="p1" projectName="프로젝트" folderSearch="" onFolderSearchChange={() => {}} onCreateFolder={async () => ({ ok: true })} />
        </NextIntlClientProvider>,
      );
    });
    const row = () => [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((r) => r.textContent?.includes('설계'))!;
    const childVisible = () => (container.textContent ?? '').includes('화면 시안');
    const start = row().getAttribute('aria-expanded');
    expect(['true', 'false']).toContain(start);
    if (start === 'true') {
      await act(async () => { row().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); });
    }
    expect(row().getAttribute('aria-expanded')).toBe('false');
    expect(childVisible()).toBe(false);
    await act(async () => { row().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
    expect(row().getAttribute('aria-expanded')).toBe('true');
    expect(childVisible()).toBe(true);
    await act(async () => { row().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); });
    expect(row().getAttribute('aria-expanded')).toBe('false');
    expect(row().querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it('자식 없는 행에는 aria-expanded가 없다(펼칠 것이 없음)', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <StorageFolderTree folders={[FOLDERS[0]!]} selectedFolderId={null} onSelectFolder={() => {}} projectId="p1" projectName="프로젝트" folderSearch="" onFolderSearchChange={() => {}} onCreateFolder={async () => ({ ok: true })} />
        </NextIntlClientProvider>,
      );
    });
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((r) => r.textContent?.includes('설계'))!;
    expect(row.hasAttribute('aria-expanded')).toBe(false);
  });

  // 유나(a1ec722dc CHANGES): 배경만 바꾸던 초점(outline-none + focus-visible:bg-muted)은 대비 1.05~1.15로 안 보였고, 고른 행에
  // 서면 고름 색을 덮었다 → 제품 초점 링을 끄지 않고 안쪽으로(-outline-offset-2) · 고름 색은 초점과 겹쳐도 남는다.
  it('나무 행 초점 = 제품 링(안쪽) — 링을 끄거나 초점 배경으로 고름 색을 덮지 않는다', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <StorageFolderTree folders={FOLDERS} selectedFolderId="f-parent" onSelectFolder={() => {}} projectId="p1" projectName="프로젝트" folderSearch="" onFolderSearchChange={() => {}} onCreateFolder={async () => ({ ok: true })} />
        </NextIntlClientProvider>,
      );
    });
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((r) => r.textContent?.includes('설계'))!;
    const cls = row.className.split(/\s+/);
    expect(cls).toContain('focus-visible:-outline-offset-2');
    expect(cls).not.toContain('outline-none');
    expect(cls).not.toContain('focus-visible:bg-muted');
    expect(cls).toContain('bg-info/10');
  });

  // PO(10:50Z): 같은 부류 — «모두» 행 · 검색 중 평면 목록 행도 같은 초점 규칙.
  it.each([
    ['«모두» 행', '', null, (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="button"]')].find((r) => r.textContent?.includes(koMessages.storage.allAssets))!],
    ['평면 목록 행(검색 중)', '설', 'f-parent', (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="button"]')].find((r) => r.textContent?.includes('설계'))!],
  ] as const)('%s 초점 = 제품 링(안쪽) · 고른 행 고름 색 유지', async (_name, search, selectedId, pick) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <StorageFolderTree folders={FOLDERS} selectedFolderId={selectedId} onSelectFolder={() => {}} projectId="p1" projectName="프로젝트" folderSearch={search} onFolderSearchChange={() => {}} onCreateFolder={async () => ({ ok: true })} />
        </NextIntlClientProvider>,
      );
    });
    const cls = pick(container).className.split(/\s+/);
    expect(cls).toContain('focus-visible:-outline-offset-2');
    expect(cls).not.toContain('outline-none');
    expect(cls).not.toContain('focus-visible:bg-muted');
    expect(cls).toContain('bg-info/10');
  });
});
