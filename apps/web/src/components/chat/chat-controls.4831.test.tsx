// @vitest-environment jsdom
//
// story 4831 부품 교체(대화 묶음) — 시험이 없던 자리: 자산 고르기 검색 칸 · 새 대화 모달의 그룹 이름 칸 · 채팅 입력의 조종(steer) 패널 선택 · 작업 항목 칸이
// 바탕 Input · Select가 되어도 동작이 그대로여야 한다. 되돌리면(날것으로) data-slot이 사라져 이 시험이 빨개진다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AssetPickerPopover } from './asset-picker-popover';
import { NewConversationModal } from './new-conversation-modal';
import { ChatInput } from './chat-input';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const chats = koMessages.chats as unknown as Record<string, string>;
function setNative(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AssetPickerPopover — 검색 칸', () => {
  it('바탕 Input(combobox)이고 입력이 반영되며, 에스케이프는 닫는다(그대로)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(<AssetPickerPopover projectId="proj-1" onSelect={vi.fn()} onClose={onClose} />)); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="input"][role="combobox"]')!;
    expect(input).toBeTruthy();
    expect(input.getAttribute('aria-controls')).toBe('asset-picker-list');
    await act(async () => { setNative(input, '기획'); });
    expect(input.value).toBe('기획');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('NewConversationModal — 그룹 이름 칸', () => {
  const MEMBERS = [
    { id: 'm-1', name: '유나', type: 'human' },
    { id: 'm-2', name: '점검봇', type: 'agent' },
    { id: 'm-3', name: '미르코', type: 'human' },
  ];
  it('둘 이상 고르면 그룹 이름 칸(바탕 Input)이 나오고, 쓴 이름이 만들기 요청 본문에 실린다', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      if (url === '/api/conversations' && init?.method === 'POST') { bodies.push(JSON.parse(init.body ?? '{}')); return { ok: true, json: async () => ({ id: 'c-new' }) }; }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => { root.render(wrap(<NewConversationModal projectId="proj-1" onClose={() => {}} onCreated={() => {}} />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const pick = async (name: string) => {
      const btn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };
    await pick('점검봇');
    expect(document.body.querySelector(`input[placeholder="${chats.groupTitlePlaceholder}"]`)).toBeNull(); // 한 명이면 이름 칸 없음
    await pick('미르코');
    const title = document.body.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${chats.groupTitlePlaceholder}"]`)!;
    expect(title).toBeTruthy();
    await act(async () => { setNative(title, '점검 모임'); });
    const create = [...document.body.querySelectorAll('button')].find((b) => b.textContent === chats.create) as HTMLButtonElement;
    await act(async () => { create.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ title: '점검 모임' });
  });
});

describe('ChatInput — 조종(steer) 패널의 선택 · 작업 항목 칸', () => {
  it('조종 토글을 켜면 대상 선택(바탕 Select)과 작업 항목 칸(바탕 Input)이 나오고 값이 반영된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await act(async () => {
      root.render(wrap(
        <ChatInput threadId="c1" onSend={vi.fn(async () => {})} currentTeamMemberId="me-1" participants={[{ member_id: 'me-1', name: '나' }, { member_id: 'm-2', name: '동료' }]} />,
      ));
    });
    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="${chats.steerToggleLabel}"]`)!;
    expect(toggle).toBeTruthy();
    await act(async () => { toggle.click(); });
    const select = container.querySelector<HTMLSelectElement>('select[data-slot="select"]')!;
    expect(select).toBeTruthy();
    expect([...select.options].map((o) => o.value)).toContain('m-2');
    await act(async () => { select.value = 'm-2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(select.value).toBe('m-2');
    const item = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${chats.steerPanelWorkItemPlaceholder}"]`)!;
    expect(item).toBeTruthy();
    await act(async () => { setNative(item, '스토리'); });
    expect(item.value).toBe('스토리');
  });
});
