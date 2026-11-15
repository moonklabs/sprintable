// @vitest-environment jsdom
// 4910 — 실제 StorageView에 파일 셋을 끌어 놓았을 때(가운데 하나가 실패): 나머지는 올라가고, 실패 알림에 «그 파일 이름»이 들어간다.
// StorageView의 주변(주소 · 알림 · 패널 상태 · 올리기 API)만 가짜로 바꾸고 화면은 진짜로 그린다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { Asset } from '@/lib/storage/types';

const addToast = vi.fn();
const uploadStorageAsset = vi.fn();

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/x/storage' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectName: '프로젝트' }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('./storage-capacity-banner', () => ({ StorageCapacityBanner: () => null }));
vi.mock('./storage-uploader-avatar', () => ({ StorageUploaderAvatar: () => <span /> }));
vi.mock('@/lib/storage/storage-upload', () => ({ uploadStorageAsset: (...a: unknown[]) => uploadStorageAsset(...a) }));
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
}));

import { StorageView } from './storage-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
beforeEach(() => {
  // 이 환경의 jsdom에는 localStorage가 없다(Node 실험 플래그) — 폴더 나무 · 패널 상태가 읽으니 메모리 저장소를 단다.
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  addToast.mockReset();
  uploadStorageAsset.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [], next_cursor: null } }), { status: 200 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const asset = (name: string): Asset => ({
  id: `id-${name}`, name, content_type: 'image/png', size_bytes: 10, folder_id: null, source_links: [],
  created_by: { id: 'm1', name: '업로더' }, updated_at: '2026-09-25T00:00:00Z', created_at: '2026-09-25T00:00:00Z',
} as unknown as Asset);

function dropEvent(files: File[]): Event {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files, items: { length: files.length } } });
  return e;
}

describe('여러 파일 끌어 놓기 — 하나가 실패해도 나머지는 올라가고 실패 알림에 그 이름(4910)', () => {
  it('⭐셋을 놓음 · 가운데(b.png) 실패 → a · c는 올라가 목록에 들어가고, 알림: 성공 a · 실패 «b.png가 들어간 문구» · 성공 c', async () => {
    uploadStorageAsset.mockImplementation(async ({ file }: { file: File }) => {
      if (file.name === 'b.png') throw new Error('upload failed');
      return asset(file.name);
    });
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StorageView projectId="p1" /></NextIntlClientProvider>);
    });
    await act(async () => { await Promise.resolve(); });
    const files = ['a.png', 'b.png', 'c.png'].map((n) => new File(['x'], n, { type: 'image/png' }));
    await act(async () => { window.dispatchEvent(dropEvent(files)); });
    for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });

    expect(uploadStorageAsset.mock.calls.map((c) => (c[0] as { file: File }).file.name)).toEqual(['a.png', 'b.png', 'c.png']); // 차례로 셋 모두
    const toasts = addToast.mock.calls.map((c) => c[0] as { title: string; body: string; type: string });
    expect(toasts.map((t) => t.type)).toEqual(['success', 'error', 'success']);
    expect(toasts[0]!.body).toBe('a.png');
    expect(toasts[1]!.title).toBe(koMessages.storage.uploadErrorTitle);
    expect(toasts[1]!.body).toContain('b.png'); // 어느 파일이 안 올라갔는지 이름으로 안다
    expect(toasts[1]!.body).toBe(koMessages.storage.uploadErrorDesc.replace('{name}', 'b.png'));
    expect(toasts[2]!.body).toBe('c.png');
    // 올라간 둘은 목록에, 실패한 것은 없다
    const names = [...container.querySelectorAll('[data-storage-row] .truncate.font-semibold')].map((e) => e.textContent);
    expect(names).toEqual(expect.arrayContaining(['a.png', 'c.png']));
    expect(names).not.toContain('b.png');
  });
});
