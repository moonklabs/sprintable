// @vitest-environment jsdom
//
// story #4349(전수 8번 · PO 11:39Z «부류를 닫는다») — 모바일 «더 보기» 메뉴가 스토리 상세 스크롤 면(`overflow-y-auto`) 안의 absolute라
// 면 아래 끝에서 잘린 채였다(AC5 트리 행 메뉴와 같은 모양). 이제 body로 포털(AnchoredPopover) · 아래 모자라면 위로.
// jsdom은 배치를 안 해서 wrapper · 메뉴 사각형을 값으로 둔다(뷰포트 768 · 메뉴 140×44).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EntityDispatchPanel } from './entity-dispatch-panel';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let anchorRect = { left: 300, right: 334, top: 200, bottom: 232 };
const dispatched: string[] = [];

beforeEach(() => {
  anchorRect = { left: 300, right: 334, top: 200, bottom: 232 };
  dispatched.length = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isMenu = this.getAttribute('data-dropdown-panel') === 'dispatch-more';
    const isAnchor = !isMenu && this.classList.contains('relative') && this.classList.contains('md:hidden');
    const r = isMenu ? { left: 194, right: 334, top: 0, bottom: 44, width: 140, height: 44 }
      : isAnchor ? { ...anchorRect, width: anchorRect.right - anchorRect.left, height: anchorRect.bottom - anchorRect.top }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: [{ id: 'm1', name: '홍길동', type: 'human', is_active: true }] }) };
    if (url === '/api/dispatch') { dispatched.push(url); return { ok: true, json: async () => ({ data: { dispatched: true, assignee_id: 'm1', reason: 'ok' } }) }; }
    return { ok: true, json: async () => ({ data: {} }) };
  }));
  container = document.createElement('div');
  container.className = 'overflow-y-auto'; // 스토리 상세 스크롤 면 흉내
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId="m1" mobileMode="assignee-only" />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const moreBtn = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${(koMessages.board as Record<string, unknown>).moreOptionsAria as string}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="dispatch-more"]');

describe('EntityDispatchPanel «더 보기» — 스크롤 면 밖(body)에 · 모자라면 위로(story #4349 전수 8번)', () => {
  it('열면 body 직속 fixed · 스크롤 면(overflow 조상) 밖 · wrapper 오른쪽 끝에 맞춰 아래 4px · z-50(스토리 패널 위)', async () => {
    await mount();
    await act(async () => { moreBtn().click(); });
    expect(menu()!.parentElement).toBe(document.body);
    expect(container.contains(menu())).toBe(false);
    expect(menu()!.style.position).toBe('fixed');
    expect(menu()!.style.top).toBe('236px');
    expect(menu()!.style.left).toBe('194px'); // 334 − 140
    expect(menu()!.dataset.side).toBe('bottom');
    expect(menu()!.className.split(' ')).toContain('z-50');
  });

  it('면 아래 끝(아래 남는 칸 < 44)이면 위로 뒤집는다', async () => {
    anchorRect = { left: 300, right: 334, top: 720, bottom: 752 };
    await mount();
    await act(async () => { moreBtn().click(); });
    expect(menu()!.dataset.side).toBe('top');
    expect(menu()!.style.top).toBe('672px'); // 720 − 4 − 44
  });

  it('포털된 메뉴 안을 누르면 안 닫히고 항목이 돈다 · 바깥을 누르면 닫힌다', async () => {
    await mount();
    await act(async () => { moreBtn().click(); });
    const item = menu()!.querySelector('button')!;
    await act(async () => { item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(menu()).not.toBeNull();
    await act(async () => { item.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(dispatched).toEqual(['/api/dispatch']);
    await act(async () => { moreBtn().click(); });
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(menu()).toBeNull();
  });

  it('포털이어도 키보드로 닿는다 — 열면 항목에 초점 · Esc면 닫고 «더 보기»로 · 스토리 패널 트랩(document keydown)까지 안 감', async () => {
    const trap = vi.fn();
    document.addEventListener('keydown', trap);
    await mount();
    moreBtn().focus();
    await act(async () => { moreBtn().click(); });
    const item = menu()!.querySelector('button')!;
    expect(document.activeElement).toBe(item);
    await act(async () => { item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    document.removeEventListener('keydown', trap);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(moreBtn());
    expect(trap.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0);
  });
});
