// @vitest-environment jsdom
//
// story #3687(3680 클래스) — @멘션 자동완성이 project_id 없는 대화(org-level DM 등)에서
// /api/members(project_id 필수, Query(...))를 불러 매 요청 422 → r.ok 검사 없이 json()으로
// 파싱 → data undefined → `?? []`로 조용히 0건.
//
// PO CHANGES(페드루, 2026-09-07) — 처음엔 /api/team-members(project_id 생략 시 org
// 스코프 폴백, S:166051f0)로 갈아탔으나, 이건 회귀였다: /api/members는 canonical
// SSOT(grant 휴먼·owner/admin 누락 없음)라 team-members(뷰 기반)로 바꾸면 project_id
// 있는 대화에서도 grant 휴먼이 @멘션에서 사라진다(BFF route.ts 주석). 정정 — FE는
// /api/members 그대로 두고, BE가 project_id 생략 시 org 스코프(grant 판정 불요) additive
// 분기를 얻었다. 실패는 실패 얼굴(mentionLoadFailed)로 드러낸다(실패≠0건).
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

async function typeAt() {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, '@');
    el.selectionStart = 1;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // effect의 fetch가 microtask 큐를 거친다 — 실 타이머 없이도 흘려보낸다.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('ChatInput — @멘션 org-스코프 폴백(story #3687 AC①)', () => {
  it('project_id 없는 대화에서도 members(org 스코프)로 멤버 ≥1건이 뜬다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/api/members');
      expect(url).not.toContain('project_id');
      return new Response(JSON.stringify({ data: [{ id: 'm1', name: 'Alice', role: 'member' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    await typeAt();

    const listbox = container.querySelector('[role="listbox"][aria-label="멘션 후보"]');
    expect(listbox).not.toBeNull();
    expect(listbox!.textContent).toContain('Alice');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('project_id 있는 대화는 여전히 project 스코프로 쿼리한다(회귀 방지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('project_id=p1');
      return new Response(JSON.stringify({ data: [{ id: 'm1', name: 'Bob', role: 'member' }] }), { status: 200 });
    }));

    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" projectId="p1" onSend={vi.fn()} />));
    });
    await typeAt();

    const listbox = container.querySelector('[role="listbox"][aria-label="멘션 후보"]');
    expect(listbox!.textContent).toContain('Bob');
  });
});

describe('ChatInput — @멘션 로드 실패 얼굴(story #3687 AC②, 실패≠0건)', () => {
  it('BE가 422를 주면 빈 목록이 아니라 실패 문구를 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ detail: 'project_id required' }), { status: 422 })));

    await act(async () => {
      root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} />));
    });
    await typeAt();

    // 실패 상태 — 후보 목록(listbox)은 없고, 실패 문구(status role)가 대신 뜬다.
    expect(container.querySelector('[role="listbox"][aria-label="멘션 후보"]')).toBeNull();
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toBe(koMessages.chats.mentionLoadFailed);
    // 실패는 실패다 — 후보가 "0건이라 안 뜬 것"과 구분되는 별도 상태(mentionLoadFailed)임을
    // 렌더 결과로 고정. r.ok 검사를 빼는 뮤테이션(수동 검증, PR 설명 참조)이 이 assertion을
    // 정확히 깨뜨린다 — 422 바디가 r.ok 없이 바로 파싱되면 data undefined→`?? []`로
    // mentionMembers만 비고 mentionLoadFailed는 계속 false라 이 role="status" 자체가 안 뜬다.
  });
});
