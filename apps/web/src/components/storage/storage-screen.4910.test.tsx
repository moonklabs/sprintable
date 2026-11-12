// @vitest-environment jsdom
// 4910 — 스토리지 재건축(옛 뼈대 그대로였던 화면). 되돌리면 RED여야 하는 구조 단언:
//  ① 우클릭 메뉴 = 행 ⋯ 메뉴와 «같은 항목 목록»(열기 · 다운로드 · 삭제 — 새 동작 0) · 격자 카드도
//  ② 더블클릭 = 열기 · Delete = 삭제 요청 · ↑↓ 형제 행으로 · 안쪽(⋯ 단추)에서 올라온 키는 행이 가로채지 않음
//  ③ 층: 행 얼굴 = rowOthers · 선택 행은 고름 색 + 링 · 행 높이 56(폰 44) · 목록 틀 = 내용 칸
//  ④ 머리 줄: 개수 + 업로드(제목은 위 막대 한 곳 — 본문 머리에 h1 없음) · 여러 파일 고르기
//  ⑤ 창에 파일 끌어 놓기: 점선 틀 · 놓으면 파일마다 한 번(차례로) · 파일 아닌 끌기는 무시
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StorageAssetList, uploadFilesOneByOne } from './storage-asset-list';
import { StorageAssetRow } from './storage-asset-row';
import { StorageAssetGrid } from './storage-asset-grid';
import type { Asset } from '@/lib/storage/types';

vi.mock('./storage-uploader-avatar', () => ({ StorageUploaderAvatar: () => <span data-testid="uploader-avatar" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

const mk = (id: string, name: string): Asset => ({
  id, name, content_type: 'application/pdf', size_bytes: 2048, folder_id: null, source_links: [],
  created_by: { id: 'm1', name: '업로더' }, updated_at: '2026-09-25T00:00:00Z', created_at: '2026-09-25T00:00:00Z',
} as unknown as Asset);
const A = mk('a1', 'brief.pdf');
const B = mk('a2', 'spec.md');
const C = mk('a3', 'notes.txt');

const intl = (n: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
const noop = () => {};
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
const KIND = [koMessages.storage.rowOpen, koMessages.storage.download, koMessages.storage.delete];

function listProps(over: Partial<React.ComponentProps<typeof StorageAssetList>> = {}): React.ComponentProps<typeof StorageAssetList> {
  return {
    assets: [A, B, C], summaryText: '3개 자산 · 6 KB', viewMode: 'list', onViewModeChange: noop, search: '', onSearchChange: noop, sort: 'date', onSortChange: noop,
    selectedAssetId: null, onSelectAsset: noop, onDeleteAsset: noop, onDownloadAsset: noop, onUploadFile: noop,
    resolveFolderLabel: () => null, loading: false, error: false, onRetry: noop, isSearchActive: false, hasMore: false, loadingMore: false, onLoadMore: noop, ...over,
  };
}
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-storage-row]')];
async function rightClick(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 80 })); });
}
async function key(el: Element, k: string) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
}

describe('우클릭 메뉴 — ⋯ 메뉴와 같은 항목(새 동작 0)', () => {
  it('⭐행 우클릭 → 열기 · 다운로드 · 삭제, 항목마다 있는 핸들러만 부른다', async () => {
    const onSelect = vi.fn(); const onDownload = vi.fn(); const onDelete = vi.fn();
    await act(async () => { root.render(intl(<StorageAssetList {...listProps({ onSelectAsset: onSelect, onDownloadAsset: onDownload, onDeleteAsset: onDelete })} />)); });
    await rightClick(rows()[1]!);
    expect(menuItems()).toEqual(KIND);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    await act(async () => { items[1]!.click(); });
    expect(onDownload).toHaveBeenCalledWith(B);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('⭐같은 행의 ⋯ 단추 메뉴와 항목 목록이 같다(우클릭 전용 동작 0 — 폰 · 키보드는 ⋯로 같은 것에 닿는다)', async () => {
    await act(async () => { root.render(intl(<StorageAssetList {...listProps()} />)); });
    const kebab = container.querySelector<HTMLElement>('[aria-label$="작업"]')!;
    await act(async () => { kebab.click(); });
    const viaKebab = menuItems();
    expect(viaKebab).toEqual(KIND);
    await key(document.activeElement ?? document.body, 'Escape');
    await rightClick(rows()[0]!);
    expect(menuItems()).toEqual(viaKebab);
  });

  it('⋯ 단추를 우클릭해도 행의 우클릭 메뉴가 겹쳐 열리지 않는다(메뉴 하나)', async () => {
    await act(async () => { root.render(intl(<StorageAssetList {...listProps()} />)); });
    await rightClick(container.querySelector('[aria-label$="작업"]')!);
    expect(document.querySelectorAll('[role="menu"]').length).toBeLessThanOrEqual(1);
  });

  it('⭐격자 카드도 우클릭 = 열기 · 다운로드 · 삭제 · 더블클릭 = 열기', async () => {
    const onSelect = vi.fn();
    await act(async () => { root.render(intl(<StorageAssetGrid assets={[A, B]} selectedAssetId={null} onSelect={onSelect} onDelete={noop} onDownload={noop} />)); });
    const card = container.querySelectorAll<HTMLElement>('[data-testid="storage-asset-grid"] > button')[1]!;
    await rightClick(card);
    expect(menuItems()).toEqual(KIND);
    onSelect.mockClear();
    await act(async () => { card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(onSelect).toHaveBeenCalledWith(B);
  });
});

describe('행 손길 — 더블클릭 · 키', () => {
  it('⭐더블클릭 = 열기(onSelect) · Enter = 열기 · Delete = 삭제 요청(확인 창은 삭제 길의 몫)', async () => {
    const onSelect = vi.fn(); const onDelete = vi.fn();
    await act(async () => { root.render(intl(<StorageAssetList {...listProps({ onSelectAsset: onSelect, onDeleteAsset: onDelete })} />)); });
    const row = rows()[0]!;
    await act(async () => { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(onSelect).toHaveBeenLastCalledWith(A);
    onSelect.mockClear();
    await key(row, 'Enter');
    expect(onSelect).toHaveBeenCalledWith(A);
    await key(row, 'Delete');
    expect(onDelete).toHaveBeenCalledWith(A);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('⭐↑ ↓ = 이웃 행으로 초점 · 맨 끝에서는 그대로', async () => {
    await act(async () => { root.render(intl(<StorageAssetList {...listProps()} />)); });
    const r = rows();
    r[0]!.focus();
    await key(r[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(r[1]);
    await key(r[1]!, 'ArrowDown');
    expect(document.activeElement).toBe(r[2]);
    await key(r[2]!, 'ArrowDown');
    expect(document.activeElement).toBe(r[2]);
    await key(r[2]!, 'ArrowUp');
    expect(document.activeElement).toBe(r[1]);
  });

  it('⭐안쪽(⋯ 단추)에서 올라온 Delete · Enter는 행이 가로채지 않는다 — 단추 위에서 Delete를 눌러 파일이 지워지면 안 된다', async () => {
    const onDelete = vi.fn(); const onSelect = vi.fn();
    await act(async () => { root.render(intl(<StorageAssetList {...listProps({ onDeleteAsset: onDelete, onSelectAsset: onSelect })} />)); });
    const kebab = container.querySelector<HTMLElement>('[aria-label$="작업"]')!;
    await key(kebab, 'Delete');
    await key(kebab, 'Enter');
    expect(onDelete).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('층 · 크기', () => {
  it('⭐행 얼굴 = 남의 글 줄 층 · 선택 행 = 고름 색 + 링 · 높이 56(폰 44) — 옛 52 고정 높이가 아니다', async () => {
    await act(async () => { root.render(intl(<StorageAssetList {...listProps({ selectedAssetId: 'a2' })} />)); });
    const [r0, r1] = rows();
    const c0 = r0!.className.split(/\s+/); const c1 = r1!.className.split(/\s+/);
    expect(c0).toContain('bg-ds-surface-high');
    expect(c0).toContain('hover:bg-ds-surface');
    expect(c0).toEqual(expect.arrayContaining(['min-h-ds-row', 'touch:min-h-ds-touch']));
    expect(c0.some((c) => /^h-\[52px\]$/.test(c))).toBe(false);
    expect(c1).toEqual(expect.arrayContaining(['bg-ds-action-soft', 'ring-ds-action']));
    expect(c1).not.toContain('bg-ds-surface-high');
    expect(r1!.getAttribute('aria-pressed')).toBe('true');
    // 폰 눌림: ⋯ 단추는 겉 26이지만 ::after가 사방 9px 넓혀 44×44(칸 폭 30 안에서)
    const kebab = r0!.querySelector<HTMLElement>('[aria-label$="작업"]')!;
    expect(kebab.className.split(/\s+/)).toEqual(expect.arrayContaining(['size-[26px]', "after:content-['']", 'after:-inset-[9px]']));
  });

  it('⭐목록 틀 = 내용 칸(ds-surface) · 옛 토큰(bg-card · border-border · text-muted-foreground) 없음', async () => {
    await act(async () => { root.render(intl(<StorageAssetList {...listProps()} />)); });
    const section = container.querySelector<HTMLElement>('[data-testid="storage-asset-list"]')!;
    expect(section.className.split(/\s+/)).toContain('bg-ds-surface');
    expect(section.innerHTML).not.toMatch(/\b(bg-card|border-border|text-muted-foreground|bg-muted|bg-info\/10)\b/);
  });

  it('⭐격자: 카드 얼굴 = rowOthers · 그림 칸 = 우물(highest) · 눌림 44 이상', async () => {
    await act(async () => { root.render(intl(<StorageAssetGrid assets={[A]} selectedAssetId={null} onSelect={noop} onDelete={noop} onDownload={noop} />)); });
    const card = container.querySelector<HTMLElement>('[data-testid="storage-asset-grid"] > button')!;
    expect(card.className.split(/\s+/)).toEqual(expect.arrayContaining(['bg-ds-surface-high', 'min-h-ds-touch']));
    expect(card.querySelector('.bg-ds-surface-highest')).not.toBeNull();
    expect(card.getAttribute('aria-label')).toBe('brief.pdf'); // 카드마다 다른 이름(반복 행 액션 이름 가드)
  });
});

describe('머리 줄 · 올리기', () => {
  it('⭐머리 줄 = 개수 글 + 업로드 단추(제목 없음 — 제목은 위 막대 한 곳) · 파일 칸은 여러 개 고르기', async () => {
    await act(async () => { root.render(intl(<StorageAssetList {...listProps()} />)); });
    const head = container.querySelector<HTMLElement>('[data-testid="storage-head"]')!;
    expect(head.querySelector('[data-testid="storage-summary"]')?.textContent).toBe('3개 자산 · 6 KB');
    expect(head.querySelector('h1, h2')).toBeNull();
    expect([...head.querySelectorAll('button')].map((b) => b.textContent)).toEqual([koMessages.storage.upload]);
    expect(head.querySelector<HTMLInputElement>('input[type="file"]')!.multiple).toBe(true);
  });

  it('⭐uploadFilesOneByOne — 파일마다 한 번 · 앞 것이 끝난 뒤에 다음(동시에 쏟지 않음)', async () => {
    const order: string[] = [];
    const upload = vi.fn(async (f: File) => { order.push(`start ${f.name}`); await Promise.resolve(); await Promise.resolve(); order.push(`end ${f.name}`); });
    await uploadFilesOneByOne([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')], upload);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['start a.txt', 'end a.txt', 'start b.txt', 'end b.txt']);
  });
});

function dragEvent(type: string, files: File[] | null, types: string[] = ['Files']): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types, files: files ?? [], items: { length: files?.length ?? 0 } } });
  return e;
}

describe('창에 파일 끌어 놓기', () => {
  it('⭐끌어 오면 점선 틀 + «N개 파일» 안내 · 떠나면 사라짐 · 놓으면 파일마다 한 번 올림(순서대로) · 틀이 사라짐', async () => {
    const onUpload = vi.fn();
    await act(async () => { root.render(intl(<StorageAssetList {...listProps({ onUploadFile: onUpload })} />)); });
    const f = [new File(['1'], 'one.png'), new File(['2'], 'two.png'), new File(['3'], 'three.png')];
    expect(container.querySelector('[data-testid="storage-drop-overlay"]')).toBeNull();
    await act(async () => { window.dispatchEvent(dragEvent('dragenter', f)); });
    const overlay = container.querySelector<HTMLElement>('[data-testid="storage-drop-overlay"]')!;
    expect(overlay.textContent).toBe('여기에 놓으면 올라가요 · 3개 파일');
    expect(overlay.className).toContain('border-dashed');
    expect(overlay.className).toContain('pointer-events-none');
    await act(async () => { window.dispatchEvent(dragEvent('dragleave', f)); });
    expect(container.querySelector('[data-testid="storage-drop-overlay"]')).toBeNull();
    await act(async () => { window.dispatchEvent(dragEvent('dragenter', f)); });
    const drop = dragEvent('drop', f);
    await act(async () => { window.dispatchEvent(drop); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(onUpload.mock.calls.map((c) => (c[0] as File).name)).toEqual(['one.png', 'two.png', 'three.png']);
    expect(drop.defaultPrevented).toBe(true); // 브라우저가 파일을 «열어» 버리지 않는다
    expect(container.querySelector('[data-testid="storage-drop-overlay"]')).toBeNull();
  });

  it('⭐파일이 아닌 끌기(글 · 링크)는 무시 — 틀도 올리기도 없음', async () => {
    const onUpload = vi.fn();
    await act(async () => { root.render(intl(<StorageAssetList {...listProps({ onUploadFile: onUpload })} />)); });
    await act(async () => { window.dispatchEvent(dragEvent('dragenter', null, ['text/plain'])); });
    expect(container.querySelector('[data-testid="storage-drop-overlay"]')).toBeNull();
    const drop = dragEvent('drop', null, ['text/plain']);
    await act(async () => { window.dispatchEvent(drop); });
    expect(onUpload).not.toHaveBeenCalled();
    expect(drop.defaultPrevented).toBe(false);
  });

  it('화면을 떠나면(unmount) 창 끌어 놓기 귀가 풀린다 — 다른 화면에서 파일을 놓아도 올라가지 않는다', async () => {
    const onUpload = vi.fn();
    await act(async () => { root.render(intl(<StorageAssetList {...listProps({ onUploadFile: onUpload })} />)); });
    await act(async () => { root.render(intl(<div />)); });
    await act(async () => { window.dispatchEvent(dragEvent('drop', [new File(['x'], 'x.png')])); });
    expect(onUpload).not.toHaveBeenCalled();
  });
});

describe('행 단독 렌더(스토리지 목록 밖)', () => {
  it('행만 그려도 우클릭이 열린다(메뉴가 목록에 의존하지 않음)', async () => {
    await act(async () => { root.render(intl(<StorageAssetRow asset={A} selected={false} folderLabel={null} onSelect={noop} onDelete={noop} onDownload={noop} />)); });
    await rightClick(container.querySelector('[data-storage-row]')!);
    expect(menuItems()).toEqual(KIND);
  });
});
