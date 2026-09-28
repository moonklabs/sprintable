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
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

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

// story #4373(까디르 실측 · 부류) — 모달 Sheet(Base UI Dialog) 안의 AnchoredPopover. Base UI 모달은 열려 있는 동안 팝업 밖 body 자식을
// aria-hidden으로 숨긴다 — body 끝 포털이던 «더 보기» 메뉴는 보조기기에서 사라졌고(항목 역할 · 이름으로 못 닿음), 시트의 바깥 누름
// 판정에서도 «밖»이었다. 이제 포털 대상 = 트리거가 든 모달 팝업(role=dialog). develop(body 포털)에선 아래 첫 테스트가 RED —
// 기존 소비처(EntityDispatchPanel)의 같은 부류 결함이 이 변경으로 닫힌다.
const sheetChange = vi.fn();

async function mountInSheet() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <Sheet open onOpenChange={sheetChange}>
            <SheetContent side="right">
              <SheetTitle>상세</SheetTitle>
              <p data-testid="sheet-body">본문</p>
              <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId="m1" mobileMode="assignee-only" />
            </SheetContent>
          </Sheet>
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="dispatch-more"]');
const moreInSheet = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${(koMessages.board as Record<string, unknown>).moreOptionsAria as string}"]`)!;
const hiddenAncestor = (el: Element | null) => {
  for (let n = el; n; n = n.parentElement) if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert')) return n;
  return null;
};

describe('EntityDispatchPanel «더 보기» — 모달 Sheet 안에서도 보조기기에 닿는다(story #4373 부류)', () => {
  beforeEach(() => sheetChange.mockReset());

  it('메뉴는 시트 팝업(role=dialog) 안 · aria-hidden/inert 조상 0 · 항목이 역할(menuitem) · 이름으로 닿는다', async () => {
    await mountInSheet();
    await act(async () => { moreInSheet().click(); });
    const popup = document.querySelector('[role="dialog"]');
    expect(popup).not.toBeNull();
    // 전제: Base UI 모달은 팝업 밖 body 자식을 숨긴다(여기선 앱 뿌리 = 테스트 컨테이너). 그래서 «팝업 안»이어야 한다.
    expect(container.getAttribute('aria-hidden')).toBe('true');
    // develop(body 포털)에선 여기서 RED — 메뉴가 팝업 밖 body 자식(실 Chromium에선 aria-hidden이 붙는 자리 · 까디르 실측).
    // jsdom에선 Base UI가 숨김을 연 순간에만 걸어 나중에 붙은 body 자식엔 속성이 안 붙는다 — 그래서 속성 말고 «팝업 안»을 못박는다.
    expect(popup!.contains(menu())).toBe(true);
    expect(hiddenAncestor(menu())).toBeNull();
    const items = [...menu()!.querySelectorAll('[role="menuitem"]')].filter((el) => !hiddenAncestor(el));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((el) => (el.textContent ?? '').trim().length > 0)).toBe(true);
    expect(menu()!.style.position).toBe('fixed');
  });

  // 회귀 못박기(jsdom에선 Base UI 바깥 누름 닫기가 body 포털에서도 안 재현돼 develop RED는 아님 — 실 브라우저는 까디르 판).
  it('메뉴 안 누름은 시트를 닫지 않는다 · 시트 본문(메뉴 밖) 누름은 메뉴만 닫는다', async () => {
    await mountInSheet();
    await act(async () => { moreInSheet().click(); });
    const item = menu()!.querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => {
      item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(sheetChange).not.toHaveBeenCalledWith(false, expect.anything());
    await act(async () => { moreInSheet().click(); });  // 항목 누름으로 닫혔을 수 있어 다시 연다
    if (!menu()) await act(async () => { moreInSheet().click(); });
    const body = document.querySelector('[data-testid="sheet-body"]')!;
    await act(async () => {
      body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(sheetChange).not.toHaveBeenCalledWith(false, expect.anything());
  });
});
