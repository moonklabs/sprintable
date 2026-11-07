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

function modalTree(projectId: string | null, memberships: typeof A[], allowNoProject: boolean) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <DashboardCtx.Provider value={{ projectMemberships: memberships } as never}>
        <NewConversationModal projectId={projectId} allowNoProject={allowNoProject} onClose={() => {}} onCreated={() => {}} />
      </DashboardCtx.Provider>
    </NextIntlClientProvider>
  );
}

async function mount(fetchMock: ReturnType<typeof vi.fn>, projectId: string | null, memberships: typeof A[], allowNoProject = false) {
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(modalTree(projectId, memberships, allowNoProject)); });
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

  it('⭐주어진 기본 프로젝트가 내 프로젝트가 아니면 기본값으로 쓰지 않는다 — 고를 때까지 만들 수 없다', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(posts), 'someone-elses-project', [A, B]);
    expect(projectSelect()!.value).toBe('');
    await click(botBtn());
    expect(createBtn().disabled).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it('⭐창이 열려 있는 동안 기본 프로젝트가 바뀌면 따라가고(고른 적 없을 때), 고른 뒤에는 고른 값을 지킨다', async () => {
    const posts: unknown[] = [];
    const fetchMock = mockFetches(posts);
    await mount(fetchMock, 'proj-a', [A, B]);
    const rerender = async (projectId: string) => {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <DashboardCtx.Provider value={{ projectMemberships: [A, B] } as never}>
              <NewConversationModal projectId={projectId} onClose={() => {}} onCreated={() => {}} />
            </DashboardCtx.Provider>
          </NextIntlClientProvider>,
        );
      });
    };
    await rerender('proj-b');
    expect(projectSelect()!.value).toBe('proj-b');
    await choose(projectSelect()!, 'proj-a');
    await rerender('proj-b');
    expect(projectSelect()!.value).toBe('proj-a');
    await click(botBtn());
    await click(createBtn());
    expect((posts[0] as { project_id: string }).project_id).toBe('proj-a');
  });
});

// story 4847 — «조직 (프로젝트 없음)»: on a server that serves the organization's rooms as a whole a room may be made with no project (the key is left out of the request).
// An older server never sees the choice.
describe('NewConversationModal — 프로젝트 없는 새 방(story 4847)', () => {
  const noneOption = () => projectSelect()?.querySelector(`option[value="none"]`) as HTMLOptionElement | null;

  it('⭐조직 전체를 읽는 서버면 «조직 (프로젝트 없음)»이 고를 수 있는 선택으로 뜬다 — 프로젝트가 하나뿐이어도(기본값은 그 프로젝트)', async () => {
    await mount(mockFetches([]), 'proj-a', [A], true);
    expect(projectSelect()).not.toBeNull();
    expect(noneOption()?.textContent).toBe(koMessages.chats.newRoomProjectNone);
    expect(projectSelect()!.value).toBe('proj-a');
  });

  it('⭐«조직 (프로젝트 없음)»을 고르면 방은 project_id 키 없이 만들어진다(있는 프로젝트를 골랐을 때는 그 프로젝트로)', async () => {
    const posts: Array<Record<string, unknown>> = [];
    await mount(mockFetches(posts), 'proj-a', [A, B], true);
    await click(botBtn());
    await choose(projectSelect()!, 'none');
    expect(createBtn().disabled).toBe(false);
    await click(createBtn());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ type: 'dm', title: null, participant_ids: ['a-bot'] });
    expect('project_id' in posts[0]!).toBe(false);
  });

  it('⭐프로젝트가 하나도 없는 사람도 방을 시작할 수 있다 — 고를 칸 없이 프로젝트 없는 방이 만들어진다', async () => {
    const posts: Array<Record<string, unknown>> = [];
    await mount(mockFetches(posts), null, [], true);
    expect(projectSelect()).toBeNull();
    await click(botBtn());
    expect(createBtn().disabled).toBe(false);
    await click(createBtn());
    expect(posts).toHaveLength(1);
    expect('project_id' in posts[0]!).toBe(false);
  });

  it('⭐걸러 보기가 «프로젝트 없음»이면 새 방의 기본값도 «조직 (프로젝트 없음)»이다(고르지 않아도 그 방이 된다)', async () => {
    const posts: Array<Record<string, unknown>> = [];
    await mount(mockFetches(posts), 'none', [A, B], true);
    expect(projectSelect()!.value).toBe('none');
    await click(botBtn());
    await click(createBtn());
    expect('project_id' in posts[0]!).toBe(false);
  });

  it('⭐옛 서버(고르게 하지 않는다)에서는 선택지가 없고, 하나뿐인 프로젝트는 묻지 않고 그 프로젝트로 만든다 — 지금과 같다', async () => {
    const posts: unknown[] = [];
    await mount(mockFetches(posts), 'proj-a', [A], false);
    expect(projectSelect()).toBeNull();
    await click(botBtn());
    await click(createBtn());
    expect(posts).toEqual([{ type: 'dm', title: null, participant_ids: ['a-bot'], project_id: 'proj-a' }]);
  });

  it('⭐옛 서버에서 프로젝트가 둘이면 고르는 칸에 «조직 (프로젝트 없음)»이 없다 · 걸러 보기 «프로젝트 없음»은 기본값이 아니다(고를 때까지 만들 수 없다)', async () => {
    await mount(mockFetches([]), 'none', [A, B], false);
    expect(noneOption()).toBeNull();
    await click(botBtn());
    expect(projectSelect()!.value).toBe('');
    expect(createBtn().disabled).toBe(true);
  });

  it('⭐옛 서버에서 프로젝트가 하나도 없는 사람은 만들 수 없다(지금과 같다) — 창이 열려 있는 동안 옛 서버로 돌아가면 «조직 (프로젝트 없음)»으로 고른 값도 거둬진다', async () => {
    await mount(mockFetches([]), null, [], false);
    await click(botBtn());
    expect(createBtn().disabled).toBe(true);
    // the same window on a server that allowed it, where «none» was chosen, then the list falls back to the older server
    await act(async () => { root.render(modalTree('proj-a', [A, B], true)); });
    await choose(projectSelect()!, 'none');
    expect(createBtn().disabled).toBe(false);
    await act(async () => { root.render(modalTree('proj-a', [A, B], false)); });
    expect(projectSelect()!.value).toBe('proj-a');
  });
});
