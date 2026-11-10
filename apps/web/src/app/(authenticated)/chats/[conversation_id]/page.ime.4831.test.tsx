// @vitest-environment jsdom
//
// story 4831 (측정 중 찾은 기존 결함) — 그룹 대화방 이름 바꾸기 칸에서 한글 조합 중의 엔터는 «글자 확정 키»인데 저장으로 읽혔고(반쯤 쓴 이름이 저장되고 편집창이 닫힘),
// 조합 중의 에스케이프는 «조합 취소 키»인데 편집창을 닫아 쓰던 이름을 잃었다(실제 Chromium 실측). 조합이 아닌 엔터는 저장, 에스케이프는 닫기 그대로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, replaceMock, searchParamsRef } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsRef: { current: '' as string },
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParamsRef.current),
}));

// ChatView 자체는 SSE(EventSource, jsdom 미구현)를 물어 이 테스트 스코프 밖 — 얇은 스텁으로 대체.
vi.mock('@/components/chat/chat-view', () => ({
  ChatView: () => <div data-testid="chat-view-stub" />,
}));

vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({
  useSyntheticParentTabHistory: () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}


beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1', projectMemberships: [] });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

const patches: Array<{ title?: string }> = [];
async function mountGroupRoom() {
  patches.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.endsWith('/api/conversations/conv-1') && init?.method === 'PATCH') { patches.push(JSON.parse(init.body ?? '{}')); return { ok: true, status: 200, json: async () => ({}) }; }
    if (u.endsWith('/api/conversations/conv-1')) {
      return { ok: true, status: 200, json: async () => ({ title: '기존 방', type: 'group', participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'm-2', name: '동료', type: 'human' }], muted: false, last_read_at: null }) };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  function TopBarRenderer() { const { title, actions } = useTopBar(); return <div>{title}{actions}</div>; }
  await act(async () => { root.render(wrap(<TopBarProvider><TopBarRenderer /><ConversationPage /></TopBarProvider>)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const editBtn = () => [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === koMessages.chats.editRoomName) as HTMLButtonElement;
const titleInput = () => container.querySelector(`input[data-slot="input"][aria-label="${koMessages.chats.editRoomName}"]`) as HTMLInputElement | null;
function keydown(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}
async function openEditor(draft: string) {
  await mountGroupRoom();
  await act(async () => { editBtn().click(); });
  const input = titleInput()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, draft);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

describe('그룹 대화방 이름 바꾸기 — 한글 조합 중 키 (story 4831 측정 중 발견)', () => {
  it('조합 중의 엔터는 저장하지 않고 편집창을 닫지 않는다 · 기본 동작도 막지 않는다', async () => {
    const input = await openEditor('기획문');
    let ev!: KeyboardEvent;
    await act(async () => { ev = keydown(input, 'Enter', { isComposing: true }); });
    await act(async () => { await Promise.resolve(); });
    expect(patches).toHaveLength(0);
    expect(titleInput()).not.toBeNull();
    expect(ev.defaultPrevented).toBe(false);
    await act(async () => { keydown(input, 'Enter', { keyCode: 229 }); });
    expect(patches).toHaveLength(0);
  });

  it('조합 중의 에스케이프는 편집창을 닫지 않고, 조합이 아닌 에스케이프는 닫는다', async () => {
    const input = await openEditor('기획문');
    await act(async () => { keydown(input, 'Escape', { isComposing: true }); });
    expect(titleInput()).not.toBeNull();
    await act(async () => { keydown(input, 'Escape'); });
    expect(titleInput()).toBeNull();
  });

  it('이름 칸은 부품의 w-full을 물려받지 않고 전처럼 자기 폭(w-auto · 축소 가능)을 쓴다 — 상단바 제목 행의 truncate가 초점 링을 자르지 않게', async () => {
    const input = await openEditor('기획');
    const cls = input.className.split(/\s+/);
    expect(cls).toContain('w-auto');
    expect(cls).not.toContain('w-full');
    expect(cls).toContain('min-w-0');
  });

  it('조합이 끝난 뒤의 엔터는 저장한다', async () => {
    const input = await openEditor('새 이름');
    await act(async () => { keydown(input, 'Enter'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(patches.map((p) => p.title)).toEqual(['새 이름']);
    expect(titleInput()).toBeNull();
  });
});
