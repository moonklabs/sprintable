// @vitest-environment jsdom
// story #4284 — 멘션 목록의 이름 없는 구성원(유나 판정 ①): 검색 예외 없음 · 행 라벨(둘 이상이면 꼬리) · 고르면 본문 `@이름 없는 구성원 `(꼬리 없음) · 배달은 id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let store: Map<string, string>;
function stubLocalStorage() {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubLocalStorage();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

async function typeAt(value = '@') {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.selectionStart = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // effect의 fetch가 microtask 큐를 거친다 — 실 타이머 없이도 흘려보낸다.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}


const MEMBERS = [
  { id: 'm-named-1', name: 'Alice', role: 'member', type: 'human' },
  { id: 'aaaa1111-0000-4000-8000-000000000001', name: null, role: 'member', type: 'human' },
  { id: 'bbbb2222-0000-4000-8000-000000000002', name: null, role: 'member', type: 'human' },
];
const UNNAMED = koMessages.common.memberUnnamed;

function stubMembers(rows: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: rows }), { status: 200 })));
}
const options = () => [...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');

describe('ChatInput — 이름 없는 구성원 멘션(story #4284 · 유나 판정 ①)', () => {
  it('⭐목록이 실패 없이 뜨고, 이름 없는 행이 둘이며 역할이 같으면 행마다 «· ID 앞 8자» 꼬리', async () => {
    stubMembers(MEMBERS);
    await act(async () => { root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />)); });
    await typeAt('@');
    const rows = options();
    expect(rows.some((r) => r.includes('Alice'))).toBe(true);
    expect(rows.some((r) => r.includes(`${UNNAMED} · aaaa1111`))).toBe(true);
    expect(rows.some((r) => r.includes(`${UNNAMED} · bbbb2222`))).toBe(true);
    expect(rows.join('|')).not.toContain('null');
    expect(container.textContent).not.toContain(koMessages.chats.mentionLoadFailed);
  });

  it('이름 없는 행이 하나뿐이면 꼬리 없음', async () => {
    stubMembers([MEMBERS[0], MEMBERS[1]]);
    await act(async () => { root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />)); });
    await typeAt('@');
    expect(options().some((r) => r.includes(UNNAMED) && !r.includes('aaaa1111'))).toBe(true);
  });

  it('⭐«@이름» 입력 — 예외 없이 이름 없는 행이 나온다(보이는 라벨로 찾음)', async () => {
    stubMembers(MEMBERS);
    await act(async () => { root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />)); });
    await typeAt('@이름');
    const rows = options();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.includes(UNNAMED))).toBe(true);
    expect(container.textContent).not.toContain(koMessages.chats.mentionLoadFailed);
  });

  it('⭐고르면 본문은 `@이름 없는 구성원 `(꼬리 없음) · 배달 id는 그 구성원', async () => {
    stubMembers(MEMBERS);
    const onMentionIdsChange = vi.fn();
    await act(async () => { root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} onMentionIdsChange={onMentionIdsChange} />)); });
    await typeAt('@');
    const target = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('aaaa1111')) as HTMLElement;
    await act(async () => { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(textarea().value).toBe(`@${UNNAMED} `);
    expect(onMentionIdsChange).toHaveBeenLastCalledWith(['aaaa1111-0000-4000-8000-000000000001']);
  });
});
