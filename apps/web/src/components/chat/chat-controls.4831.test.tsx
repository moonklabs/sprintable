// @vitest-environment jsdom
//
// story 4831 부품 교체(대화 묶음) — 시험이 없던 자리: 자산 고르기 검색 칸 · 새 대화 모달의 그룹 이름 칸 · 채팅 입력의 조종(steer) 패널 선택 · 작업 항목 칸이
// 바탕 Input · Select가 되어도 동작이 그대로여야 한다. 값을 직접 넣고 읽는 것으로는 onChange 고장을 못 잡으므로, 입력이 일으킨 결과(조회 질의 · 제어되는 선택값 · 발송 내용 · 고르기)로 단언한다.
// 되돌리면(날것으로) data-slot이 사라져 이 시험이 빨개진다.
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

const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const queryOf = (url: string, key: string) => new URL(url, 'http://x.test').searchParams.get(key);

describe('AssetPickerPopover — 검색 칸', () => {
  it('입력하면(디바운스 뒤) 그 글자가 자산 조회 질의 q로 나가고, 에스케이프는 닫는다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { items: [] } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(<AssetPickerPopover projectId="proj-1" onSelect={vi.fn()} onClose={onClose} />)); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="input"][role="combobox"]')!;
    expect(input).toBeTruthy();
    expect(input.getAttribute('aria-controls')).toBe('asset-picker-list');
    const urls = () => (fetchMock.mock.calls as unknown as Array<[string]>).map((c) => c[0]).filter((u) => u.startsWith('/api/assets'));
    expect(urls().every((u) => queryOf(u, 'q') === null)).toBe(true); // 처음엔 질의 없음
    await act(async () => { setNative(input, '기획'); });
    await sleep(350); // 디바운스 200ms
    expect(urls().some((u) => queryOf(u, 'q') === '기획' && queryOf(u, 'project_id') === 'proj-1')).toBe(true);
    expect(input.value).toBe('기획'); // 제어되는 값이 입력 뒤에도 유지
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
  it('대상 선택 · 작업 항목 고르기 · 지시 입력이 모두 반영되어, 엔터로 보내면 고른 대상 · 항목 · 지시가 발행 요청에 실린다', async () => {
    const published: Array<{ definition_key?: string; conversation_id?: string; payload?: Record<string, unknown> }> = [];
    const searches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.startsWith('/api/entities/search')) {
        searches.push(url);
        return new Response(JSON.stringify({ data: [{ entity_type: 'story', entity_id: 's-1', title: '스토리 하나', status: 'in-progress' }] }), { status: 200 });
      }
      if (url === '/api/events/publish' && init?.method === 'POST') { published.push(JSON.parse(init.body ?? '{}')); return new Response('{}', { status: 200 }); }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await act(async () => {
      root.render(wrap(
        <ChatInput threadId="c1" projectId="proj-1" onSend={vi.fn(async () => {})} currentTeamMemberId="me-1" participants={[{ member_id: 'me-1', name: '나' }, { member_id: 'm-2', name: '동료' }]} />,
      ));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${chats.steerToggleLabel}"]`)!.click(); });

    // ① 대상 선택 — 제어되는 값이 되돌려지지 않고 유지된다
    const select = container.querySelector<HTMLSelectElement>('select[data-slot="select"]')!;
    expect(select).toBeTruthy();
    expect([...select.options].map((o) => o.value)).toEqual(['', 'm-2']); // 본인 제외
    await act(async () => { select.value = 'm-2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(0);
    expect(container.querySelector<HTMLSelectElement>('select[data-slot="select"]')!.value).toBe('m-2');

    // ② 작업 항목 칸 — 초점이 후보 조회를 시작하고(onFocus), 입력이 질의가 되고(onChange), 후보를 고르면 칸에 제목이 들어간다
    const item = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${chats.steerPanelWorkItemPlaceholder}"]`)!;
    expect(item).toBeTruthy();
    await act(async () => { item.focus(); });
    await sleep(350);
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((u) => queryOf(u, 'q') === null)).toBe(true); // 초점만으로는 질의 글자 없음
    await act(async () => { setNative(item, '스토'); });
    await sleep(350);
    expect(searches.some((u) => queryOf(u, 'q') === '스토' && queryOf(u, 'project_id') === 'proj-1')).toBe(true);
    const row = [...container.querySelectorAll<HTMLButtonElement>('[role="listbox"] button')].find((b) => b.textContent?.includes('스토리 하나'))!;
    expect(row).toBeTruthy();
    await act(async () => { row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
    expect(container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${chats.steerPanelWorkItemPlaceholder}"]`)!.value).toBe('스토리 하나');

    // ③ 지시를 쓰고 엔터 — 고른 대상 · 항목 · 지시가 그대로 발행 요청에 실린다
    const ta = container.querySelector<HTMLTextAreaElement>('textarea[data-slot="textarea"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, '이 스토리를 먼저 봐 줘');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      definition_key: 'preset.steer.instruct',
      conversation_id: 'c1',
      payload: { work_item_type: 'story', work_item_id: 's-1', target_member_id: 'm-2', instruction: '이 스토리를 먼저 봐 줘' },
    });
  });
});
