// @vitest-environment jsdom
//
// story #4357 AC1(유나 공통 모양 · 4348과 같은 결) — 디스패치가 담당자 없어 꺼진 까닭 «에이전트를 먼저 선택하세요»가 title(호버)에만 있어
// 터치 · 키보드 · 화면 읽기에 안 닿았다. 이제 까닭은 **보이는 한 줄** · 버튼은 aria-disabled(탭 순서에 남아 초점이 닿음) +
// aria-describedby로 그 줄을 가리킴 · 누르거나 Enter여도 무동작. 좁은 화면 «더 보기» 메뉴 항목도 메뉴 안 border-t 한 줄로 같게.
// 옛 코드(네이티브 disabled + title만)면 aria-describedby · 보이는 줄이 없어 RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EntityDispatchPanel } from './entity-dispatch-panel';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const board = koMessages.board as Record<string, unknown>;
const REASON = board.dispatchNeedsAssignee as string;
const TOOLTIP = board.dispatchTooltip as string;
const DISPATCH = board.dispatch as string;

let container: HTMLDivElement;
let root: Root;
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/api/members')) return { ok: true, json: async () => ({ data: [{ id: 'm1', name: '홍길동', type: 'human', is_active: true }] }) };
    if (url === '/api/dispatch') return { ok: true, json: async () => ({ data: { dispatched: true } }) };
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

async function mount(props: { currentAssigneeId?: string | null; mobileMode?: 'full' | 'assignee-only' } = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <EntityDispatchPanel entityType="story" entityId="s1" projectId="p1" currentAssigneeId={props.currentAssigneeId ?? null} mobileMode={props.mobileMode} />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const dispatchBtn = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(DISPATCH))!;
const describedText = (el: Element) => {
  const id = el.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};
const dispatchCalls = () => calls.filter((u) => u === '/api/dispatch' || u.startsWith('/api/stories/'));

describe('디스패치 꺼짐 까닭 — 보이는 한 줄 · aria-disabled + aria-describedby(story #4357 AC1)', () => {
  it('⭐담당자 없음 → 까닭 줄이 보이고 버튼이 그 줄을 가리킴 · 초점이 닿음(네이티브 disabled 아님) · title 까닭 없음', async () => {
    await mount();
    const btn = dispatchBtn();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.disabled).toBe(false);
    expect(describedText(btn)).toBe(REASON);
    const line = document.getElementById(btn.getAttribute('aria-describedby')!)!;
    expect(line.tagName).toBe('P');
    expect(line.className).toContain('break-keep');
    expect(container.contains(line)).toBe(true);
    expect(btn.hasAttribute('title')).toBe(false);
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });

  it('⭐꺼진 채 누르거나 Enter여도 무동작(배정 PATCH · 디스패치 요청 0)', async () => {
    await mount();
    const btn = dispatchBtn();
    await act(async () => { btn.click(); });
    btn.focus();
    await act(async () => { btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(dispatchCalls()).toEqual([]);
  });

  it('⭐담당자를 고르면 까닭 줄이 사라지고 버튼이 켜짐(aria-disabled · describedby 없음) · title은 «무엇을 하나» 설명', async () => {
    await mount();
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'm1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const btn = dispatchBtn();
    expect(btn.hasAttribute('aria-disabled')).toBe(false);
    expect(btn.hasAttribute('aria-describedby')).toBe(false);
    expect(container.textContent).not.toContain(REASON);
    expect(btn.getAttribute('title')).toBe(TOOLTIP);
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(dispatchCalls()).toContain('/api/dispatch');
  });

  it('⭐«더 보기» 메뉴 항목(담당자만 모드)도 메뉴 안 border-t 한 줄을 가리킴 · 꺼진 채 누르면 메뉴는 열린 채 무동작', async () => {
    await mount({ mobileMode: 'assignee-only' });
    const more = container.querySelector<HTMLButtonElement>(`button[aria-label="${board.moreOptionsAria as string}"]`)!;
    await act(async () => { more.click(); });
    const menu = document.querySelector<HTMLElement>('[data-dropdown-panel="dispatch-more"]')!;
    const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.disabled).toBe(false);
    expect(item.hasAttribute('title')).toBe(false);
    expect(describedText(item)).toBe(REASON);
    const line = document.getElementById(item.getAttribute('aria-describedby')!)!;
    expect(menu.contains(line)).toBe(true);
    expect(line.className).toContain('border-t');
    await act(async () => { item.click(); });
    expect(document.querySelector('[data-dropdown-panel="dispatch-more"]')).not.toBeNull();
    expect(dispatchCalls()).toEqual([]);
    // 좁은 화면에선 버튼이 숨으므로 줄 아래 한 줄도 같이 숨는다(메뉴 줄이 대신).
    const rowLine = document.getElementById(dispatchBtn().getAttribute('aria-describedby')!)!;
    expect(rowLine.className).toContain('hidden');
    expect(rowLine.className).toContain('md:block');
  });
});
