// @vitest-environment jsdom
// 5668의 결함(둘째) — 서랍 방식(1536 미만)에서 행을 더블클릭하면 첫 클릭이 서랍을 열고 둘째 클릭이 그 배경 막을 눌러 서랍을 닫았다(dev 실측 11-12).
// 시간이 아니라 클릭 횟수: 막을 «처음» 누른 클릭(detail 1)만 닫고, 같은 연속 누름의 둘째 이후(detail ≥ 2)는 서랍을 그대로 둔다. 실제 StorageView + 실제 서랍.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/x/storage' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectName: '프로젝트' }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('./storage-capacity-banner', () => ({ StorageCapacityBanner: () => null }));
vi.mock('./storage-uploader-avatar', () => ({ StorageUploaderAvatar: () => <span /> }));
vi.mock('./storage-thumbnail', () => ({ StorageThumbnail: () => <span /> }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) }));

import { StorageView } from './storage-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
const asset = (id: string, name: string) => ({
  id, name, content_type: 'application/pdf', size_bytes: 10, folder_id: null, source_links: [],
  created_by: { id: 'm1', name: '업로더' }, updated_at: '2026-09-25T00:00:00Z', created_at: '2026-09-25T00:00:00Z',
});

/** 1536 이상(인라인 칸)이면 서랍이 없다 — matchMedia로 폭을 정한다(서랍 방식 = matches false). */
function setInline(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [asset('a1', 'brief.pdf'), asset('a2', 'spec.md')], next_cursor: null } }), { status: 200 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StorageView projectId="p1" /></NextIntlClientProvider>); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}
const drawer = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"][aria-label="스토리지"]');
const backdrop = () => drawer()?.querySelector<HTMLButtonElement>('button[aria-label="취소"]') ?? null;
const clickWithDetail = async (el: Element, detail: number) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); }); };

describe('서랍 방식에서 행 더블클릭 = 열린 채로(5668의 결함 둘째)', () => {
  it('⭐행 클릭 → 서랍 열림 → 배경 막에 «둘째 이후 클릭(detail 2)»이 닿아도 서랍이 열린 채 — 더블클릭 = 열기', async () => {
    setInline(false);
    await render();
    const row = container.querySelector<HTMLElement>('[data-storage-row]')!;
    await clickWithDetail(row, 1);
    expect(drawer(), '첫 클릭으로 서랍이 열림').not.toBeNull();
    await clickWithDetail(backdrop()!, 2); // 같은 연속 누름의 둘째 클릭이 막에 닿음
    expect(drawer(), '둘째 클릭은 서랍을 닫지 않음').not.toBeNull();
    await clickWithDetail(backdrop()!, 3);
    expect(drawer(), '셋째도 마찬가지').not.toBeNull();
  });

  it('⭐막을 «처음» 누르면(detail 1) 지금처럼 닫힌다 · 키보드로 눌러도(detail 0) 닫힌다', async () => {
    setInline(false);
    await render();
    const row = container.querySelector<HTMLElement>('[data-storage-row]')!;
    await clickWithDetail(row, 1);
    await clickWithDetail(backdrop()!, 1);
    expect(drawer()).toBeNull();
    await clickWithDetail(row, 1);
    expect(drawer()).not.toBeNull();
    await clickWithDetail(backdrop()!, 0);
    expect(drawer()).toBeNull();
  });

  it('1536 이상(인라인 칸)은 서랍이 없다 — 행을 눌러도 대화 상자가 안 뜬다(변화 0)', async () => {
    setInline(true);
    await render();
    const row = container.querySelector<HTMLElement>('[data-storage-row]')!;
    await clickWithDetail(row, 1);
    await clickWithDetail(row, 2);
    expect(drawer()).toBeNull();
  });
});
