// @vitest-environment jsdom
//
// [SID:4367] 한 Esc = 한 층 — 저장소 폴더 서랍(모바일 · 실제 useFocusTrap) 안 «새 폴더» 입력칸의 Esc는 입력칸만 닫는다. 입력칸은 전부터
// preventDefault했지만 가두기(document Esc)가 그 표시를 안 봐 서랍까지 닫았다(실 브라우저 판 · 배포 36과 같은 소스).
// 둘째 Esc로 서랍이 닫히는 것이 양성 대조(가두기가 살아 있다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StorageFolderTree } from './storage-folder-tree';
import { useFocusTrap } from '@/hooks/use-focus-trap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
// 이 jsdom 환경은 localStorage를 안 준다(docs-client-layout.test.tsx와 같은 폴리필 — 트리 펼침 상태 저장소).
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => { store.clear(); } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

// storage-view.tsx의 폴더 서랍과 같은 배선 — useFocusTrap(열림, 닫기) 안에 StorageFolderTree.
function Drawer({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const close = useCallback(() => { onClose(); setOpen(false); }, [onClose]);
  const ref = useFocusTrap(open, close);
  if (!open) return <p data-testid="closed">닫힘</p>;
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" data-testid="drawer">
      <StorageFolderTree folders={[]} selectedFolderId={null} onSelectFolder={() => {}} projectId="p1" projectName="프로젝트" folderSearch="" onFolderSearchChange={() => {}} onCreateFolder={async () => ({ ok: true })} />
    </div>
  );
}

describe('StorageFolderTree — 서랍 안 새 폴더 입력칸 Esc는 입력칸만([SID:4367])', () => {
  it('새 폴더 입력칸에서 Esc → 입력칸 닫힘 · 서랍 그대로 → 한 번 더 Esc → 서랍 닫힘(양성 대조)', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Drawer onClose={onClose} /></NextIntlClientProvider>);
    });
    const newFolder = container.querySelector(`button[aria-label="${koMessages.storage.newFolderAction}"]`) as HTMLButtonElement;
    await act(async () => { newFolder.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container.querySelector(`input[placeholder="${koMessages.storage.newFolderPlaceholder}"]`) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(container.querySelector(`input[placeholder="${koMessages.storage.newFolderPlaceholder}"]`)).toBeNull();
    expect(container.querySelector('[data-testid="drawer"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="closed"]')).not.toBeNull();
  });
});
