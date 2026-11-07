// @vitest-environment jsdom
//
// story 4847 (AC3) — a new conversation's people come from the organization (no project in the read), and the room itself is filed under one project:
// the given default, changeable when the person can use more than one, asked for when there is no default.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NewConversationModal } from './new-conversation-modal';
import { DashboardCtx } from '@/app/dashboard/dashboard-shell';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const A = { projectId: 'proj-a', projectName: '프로젝트 에이' };
const B = { projectId: 'proj-b', projectName: '프로젝트 비' };
const MEMBERS = [{ id: 'a-bot', name: '점검봇', type: 'agent' }];

function mockFetches(posts: unknown[]) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
    if (url === '/api/conversations' && init?.method === 'POST') {
      posts.push(JSON.parse(init.body!));
      return { ok: true, json: async () => ({ id: 'new-room' }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

async function mount(fetchMock: ReturnType<typeof vi.fn>, projectId: string | null, memberships: typeof A[]) {
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DashboardCtx.Provider value={{ projectMemberships: memberships } as never}>
          <NewConversationModal projectId={projectId} onClose={() => {}} onCreated={() => {}} />
        </DashboardCtx.Provider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const botBtn = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('점검봇'))!;
const createBtn = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.chats.create) as HTMLButtonElement;
const projectSelect = () => document.body.querySelector('#new-room-project') as HTMLSelectElement | null;

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('NewConversationModal — 조직 구성원 · 방의 프로젝트(story 4847)', () => {
  it('⭐상대 목록을 project_id 없이 읽는다', async () => {
    const fetchMock = mockFetches([]);
    await mount(fetchMock, 'proj-a', [A, B]);
    const reads = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/members'));
    expect(reads).toEqual(['/api/members?is_active=true']);
  });

  it('⭐기본 프로젝트가 있으면 그 프로젝트로 방을 만든다(프로젝트가 하나뿐이면 고르는 칸은 안 그린다)', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(posts), 'proj-a', [A]);
    expect(projectSelect()).toBeNull();
    await click(botBtn());
    await click(createBtn());
    expect(posts).toEqual([{ type: 'dm', title: null, participant_ids: ['a-bot'], project_id: 'proj-a' }]);
  });

  it('⭐프로젝트가 둘 이상이면 고르는 칸이 뜨고, 고른 프로젝트로 방이 만들어진다', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(posts), 'proj-a', [A, B]);
    const select = projectSelect()!;
    expect(select.value).toBe('proj-a');
    expect([...select.options].map((o) => o.textContent)).toEqual([A.projectName, B.projectName]);
    await choose(select, 'proj-b');
    await click(botBtn());
    await click(createBtn());
    expect((posts[0] as { project_id: string }).project_id).toBe('proj-b');
  });

  it('⭐기본 프로젝트가 없으면(프로젝트 둘 이상) 고르기 전엔 만들 수 없고, 고르면 만들 수 있다', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(posts), null, [A, B]);
    await click(botBtn());
    expect(createBtn().disabled).toBe(true);
    await choose(projectSelect()!, 'proj-a');
    expect(createBtn().disabled).toBe(false);
    await click(createBtn());
    expect((posts[0] as { project_id: string }).project_id).toBe('proj-a');
  });

  it('기본 프로젝트가 없어도 쓸 수 있는 프로젝트가 하나뿐이면 그 프로젝트로 만든다', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(posts), null, [B]);
    await click(botBtn());
    await click(createBtn());
    expect((posts[0] as { project_id: string }).project_id).toBe('proj-b');
  });
});
