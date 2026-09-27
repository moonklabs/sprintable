// @vitest-environment jsdom
//
// 유나 #4728 필수 1 — 문서 담당자 창(<md · EntityDispatchPanel mobileMode="assignee-only") 안 «더 보기» 메뉴가 #4349 PR 2로 body에 포털되자,
// 실제 탭 · 클릭으로 «이벤트 전달»을 눌러도 디스패치 요청이 0이었다(Enter는 1).
// 까닭 = 실제 이벤트 순서: 누름의 mousedown이 먼저 document까지 올라와 담당자 창의 바깥 누름 닫기(`ref.contains`만 봄)가 창을 닫고,
// 그 안의 메뉴도 언마운트돼 뒤따르는 click이 항목에 닿지 않는다. 이제 부모도 공용 `isOutsidePress`(포털 팝오버 안 = 안)로 판정한다.
// 이 테스트는 그 순서를 그대로 흉내 낸다: 항목에 mousedown(버블 · document까지) → mouseup → click.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';
import { DocAssigneeControl } from './doc-assignee-control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const dispatched: string[] = [];
const order: string[] = [];

beforeEach(() => {
  dispatched.length = 0;
  order.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: [{ id: 'm1', name: '홍길동', type: 'human', is_active: true }] }) };
    if (url === '/api/dispatch') { dispatched.push(url); return { ok: true, json: async () => ({ data: { dispatched: true, assignee_id: 'm1', reason: 'ok' } }) }; }
    return { ok: true, json: async () => ({ data: {} }) };
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountOpen() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <DocAssigneeControl docId="d1" projectId="p1" currentAssigneeId="m1" assigneeName="홍길동" onAssigneePatched={() => {}} />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  const avatar = container.querySelector<HTMLButtonElement>('button')!;
  await act(async () => { avatar.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const assigneePanel = () => container.querySelector<HTMLElement>('[data-dropdown-panel="doc-assignee"]');
const moreBtn = () => assigneePanel()!.querySelector<HTMLButtonElement>(`button[aria-label="${(koMessages.board as Record<string, unknown>).moreOptionsAria as string}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="dispatch-more"]');

/** 실제 누름 순서 — mousedown(document까지 버블) → mouseup → click. 각 단계 뒤 React가 다시 그리게 act로 감싼다. */
async function realPress(el: HTMLElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
  order.push(`mousedown · 창 ${assigneePanel() ? '열림' : '닫힘'} · 메뉴 ${menu() ? '있음' : '없음'}`);
  await act(async () => { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); });
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('DocAssigneeControl × 포털 «더 보기»(유나 #4728 필수 1)', () => {
  it('포털 메뉴 «이벤트 전달»을 실제 순서로 누르면 — mousedown 뒤에도 담당자 창 · 메뉴가 살아 있고 click이 닿아 디스패치 1', async () => {
    await mountOpen();
    expect(assigneePanel()).not.toBeNull();
    await act(async () => { moreBtn().click(); });
    const item = menu()!.querySelector<HTMLButtonElement>('button')!;
    expect(menu()!.parentElement).toBe(document.body); // 포털 — 담당자 창 DOM 밖
    expect(assigneePanel()!.contains(item)).toBe(false);
    await realPress(item);
    expect(order).toEqual(['mousedown · 창 열림 · 메뉴 있음']);
    expect(dispatched).toEqual(['/api/dispatch']);
    expect(assigneePanel()).not.toBeNull();
  });

  it('대조: 담당자 창 · 포털 메뉴 밖을 누르면 담당자 창이 닫힌다', async () => {
    await mountOpen();
    await act(async () => { moreBtn().click(); });
    const outside = document.createElement('p');
    document.body.appendChild(outside);
    await realPress(outside);
    outside.remove();
    expect(assigneePanel()).toBeNull();
    expect(dispatched).toEqual([]);
  });
});

describe('DocAssigneeControl — Esc · 트리거 ARIA(story #4364 AC3 · 유나 4737 판)', () => {
  const avatar = () => container.querySelector<HTMLButtonElement>('button')!;
  const pressEscape = async (el: Element) => {
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  };

  it('트리거 aria-expanded가 창 열림을 따르고 aria-controls가 창을 가리킨다', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ToastProvider>
            <DocAssigneeControl docId="d1" projectId="p1" currentAssigneeId="m1" assigneeName="홍길동" onAssigneePatched={() => {}} />
          </ToastProvider>
        </NextIntlClientProvider>,
      );
    });
    expect(avatar().getAttribute('aria-expanded')).toBe('false');
    await act(async () => { avatar().click(); });
    expect(avatar().getAttribute('aria-expanded')).toBe('true');
    expect(avatar().getAttribute('aria-controls')).toBe(assigneePanel()!.id);
  });

  it('«더 보기»에 초점 둔 채 Esc 두 번 — 첫 번째는 메뉴만 · 두 번째는 창을 닫고 초점은 아바타로(유나 재현: 예전엔 창 그대로)', async () => {
    await mountOpen();
    await act(async () => { moreBtn().click(); });
    expect(menu()).not.toBeNull();
    await pressEscape(document.activeElement ?? menu()!);  // 메뉴는 열면 첫 항목 초점 — 그 자리에서 Esc
    expect(menu()).toBeNull();
    expect(assigneePanel()).not.toBeNull();
    expect(document.activeElement).toBe(moreBtn());  // 메뉴 훅이 «더 보기»로 돌려놓는다
    await pressEscape(moreBtn());
    expect(assigneePanel()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    expect(avatar().getAttribute('aria-expanded')).toBe('false');
  });
});
